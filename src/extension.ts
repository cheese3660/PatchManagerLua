import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';

const PROMPT_DECLINED_KEY = 'pmLua.promptDeclined';
const STUBS_REL_PATH = '.pmlua/stubs';
const GITIGNORE_ENTRY = '.pmlua/';

interface PmConfig {
    repo: string;
    branch: string;
    stubsPath: string;
    autoPrompt: boolean;
}

function getConfig(): PmConfig {
    const cfg = vscode.workspace.getConfiguration('pmLua');
    return {
        repo: cfg.get<string>('repo', 'KSP2Community/PatchManager'),
        branch: cfg.get<string>('branch', 'unity'),
        stubsPath: cfg.get<string>('stubsPath', 'Stubs'),
        autoPrompt: cfg.get<boolean>('autoPrompt', true),
    };
}

function bundledStubsDir(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'stubs');
}

function workspaceStubsDir(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, STUBS_REL_PATH);
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('pmLua.configureWorkspace', () => configureWorkspace(context)),
        vscode.commands.registerCommand('pmLua.updateStubs', () => updateStubs()),
        vscode.commands.registerCommand('pmLua.openStubsFolder', () => openStubsFolder()),
        vscode.commands.registerCommand('pmLua.resetStubs', () => resetStubs(context)),
    );

    maybePromptForSetup(context).catch(err => console.error('PatchManager Lua: prompt failed', err));
}

export function deactivate() {}

async function maybePromptForSetup(context: vscode.ExtensionContext) {
    if (!getConfig().autoPrompt) return;
    if (!vscode.workspace.workspaceFolders?.length) return;
    if (context.workspaceState.get<boolean>(PROMPT_DECLINED_KEY)) return;
    if (await isAnyFolderConfigured()) return;

    const choice = await vscode.window.showInformationMessage(
        'Configure this workspace for PatchManager Lua patches?',
        'Configure',
        'Not now',
        "Don't ask again",
    );
    if (choice === 'Configure') {
        await configureWorkspace(context);
    } else if (choice === "Don't ask again") {
        await context.workspaceState.update(PROMPT_DECLINED_KEY, true);
    }
}

async function isAnyFolderConfigured(): Promise<boolean> {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        const lua = vscode.workspace.getConfiguration('Lua', f.uri);
        const symbols = lua.get<string[]>('runtime.nonstandardSymbol') ?? [];
        if (symbols.includes('|lambda|')) return true;
    }
    return false;
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        vscode.window.showWarningMessage('PatchManager Lua: open a folder or workspace first.');
        return undefined;
    }
    if (folders.length === 1) return folders[0];
    const pick = await vscode.window.showQuickPick(
        folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: 'Select the workspace folder to configure' },
    );
    return pick?.folder;
}

async function configureWorkspace(context: vscode.ExtensionContext) {
    const folder = await pickFolder();
    if (!folder) return;

    const stubsDir = workspaceStubsDir(folder);
    await fs.promises.mkdir(stubsDir, { recursive: true });

    const existing = await fs.promises.readdir(stubsDir);
    if (!existing.some(f => f.endsWith('.d.lua'))) {
        await copyDir(bundledStubsDir(context), stubsDir);
    }

    await ensureGitignored(folder.uri.fsPath, GITIGNORE_ENTRY);
    await applyLuaSettings(folder);

    vscode.window.showInformationMessage(
        `PatchManager Lua: configured ${folder.name} (${STUBS_REL_PATH}).`,
    );
}

async function applyLuaSettings(folder: vscode.WorkspaceFolder) {
    const lua = vscode.workspace.getConfiguration('Lua', folder.uri);
    const target = vscode.ConfigurationTarget.WorkspaceFolder;

    await lua.update('runtime.version', 'Lua 5.2', target);
    await lua.update('workspace.checkThirdParty', false, target);

    const symbols = lua.get<string[]>('runtime.nonstandardSymbol') ?? [];
    if (!symbols.includes('|lambda|')) {
        await lua.update('runtime.nonstandardSymbol', [...symbols, '|lambda|'], target);
    }

    const lib = lua.get<string[]>('workspace.library') ?? [];
    if (!lib.includes(STUBS_REL_PATH)) {
        await lua.update('workspace.library', [...lib, STUBS_REL_PATH], target);
    }

    const disable = lua.get<string[]>('diagnostics.disable') ?? [];
    if (!disable.includes('lowercase-global')) {
        await lua.update('diagnostics.disable', [...disable, 'lowercase-global'], target);
    }
}

async function ensureGitignored(folderPath: string, entry: string): Promise<void> {
    if (!fs.existsSync(path.join(folderPath, '.git'))) return; // not a git repo

    const gitignorePath = path.join(folderPath, '.gitignore');
    let contents = '';
    if (fs.existsSync(gitignorePath)) {
        contents = await fs.promises.readFile(gitignorePath, 'utf8');
    }

    const trimmedEntry = entry.replace(/\/$/, '');
    const has = contents.split(/\r?\n/).some(line => {
        const t = line.trim();
        return t === entry || t === trimmedEntry;
    });
    if (has) return;

    const prefix = contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
    await fs.promises.writeFile(gitignorePath, contents + prefix + entry + '\n');
}

async function copyDir(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
        const sp = path.join(src, entry.name);
        const dp = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(sp, dp);
        } else if (entry.isFile()) {
            await fs.promises.copyFile(sp, dp);
        }
    }
}

async function updateStubs() {
    const folder = await pickFolder();
    if (!folder) return;

    const { repo, branch, stubsPath } = getConfig();
    const dest = workspaceStubsDir(folder);

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching PatchManager stubs from ${repo}@${branch}` },
            async progress => {
                await fs.promises.mkdir(dest, { recursive: true });

                progress.report({ message: 'listing files' });
                const files = (await listRepoFiles(repo, branch, stubsPath))
                    .filter(f => f.name.endsWith('.d.lua'));
                if (files.length === 0) {
                    throw new Error(`no .d.lua files found at ${repo}/${stubsPath}@${branch}`);
                }

                for (const [i, file] of files.entries()) {
                    progress.report({ message: `${i + 1}/${files.length} ${file.name}` });
                    const body = await httpGet(file.download_url);
                    await fs.promises.writeFile(path.join(dest, file.name), body);
                }

                for (const old of await fs.promises.readdir(dest)) {
                    if (old.endsWith('.d.lua') && !files.some(f => f.name === old)) {
                        await fs.promises.unlink(path.join(dest, old)).catch(() => {});
                    }
                }
            },
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`PatchManager Lua: update failed — ${err?.message ?? err}`);
        return;
    }

    await ensureGitignored(folder.uri.fsPath, GITIGNORE_ENTRY);
    await applyLuaSettings(folder);
    vscode.window.showInformationMessage(`PatchManager Lua: stubs updated in ${folder.name}.`);
}

interface GhContentEntry {
    name: string;
    type: 'file' | 'dir' | string;
    download_url: string;
}

async function listRepoFiles(repo: string, branch: string, dir: string): Promise<GhContentEntry[]> {
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURI(dir)}?ref=${encodeURIComponent(branch)}`;
    const body = await httpGet(url, { 'Accept': 'application/vnd.github+json' });
    const parsed = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(parsed)) {
        const msg = parsed && parsed.message ? parsed.message : 'unexpected response';
        throw new Error(`GitHub API: ${msg}`);
    }
    return parsed.filter((e: GhContentEntry) => e.type === 'file');
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'pm-lua-extension', ...headers } }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpGet(res.headers.location, headers).then(resolve, reject);
                res.resume();
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => req.destroy(new Error('request timed out')));
    });
}

async function openStubsFolder() {
    const folder = await pickFolder();
    if (!folder) return;
    const dir = workspaceStubsDir(folder);
    if (!fs.existsSync(dir)) {
        vscode.window.showWarningMessage(
            `PatchManager Lua: ${STUBS_REL_PATH} not found in ${folder.name}. Run "Configure Workspace" first.`,
        );
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

async function resetStubs(context: vscode.ExtensionContext) {
    const folder = await pickFolder();
    if (!folder) return;

    const dest = workspaceStubsDir(folder);
    if (fs.existsSync(dest)) {
        for (const f of await fs.promises.readdir(dest)) {
            if (f.endsWith('.d.lua')) await fs.promises.unlink(path.join(dest, f)).catch(() => {});
        }
    }
    await fs.promises.mkdir(dest, { recursive: true });
    await copyDir(bundledStubsDir(context), dest);
    vscode.window.showInformationMessage(`PatchManager Lua: reset to bundled stubs in ${folder.name}.`);
}
