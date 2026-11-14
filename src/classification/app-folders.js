/**
 * Folder names inside an AI app's own data folder that say what the files below them are.
 * One list for the classifier and the suggested cleanup, so they never disagree.
 */

/** Where people keep things in an app's folder: skills, agents, commands, memory, backups, plug-ins. */
export const KEPT_FOLDERS = new Set(['backups', 'backup', 'skills', 'plugins', 'agents', 'commands', 'memory', 'settings', 'projects', 'sessions', 'prompts', 'rules']);

/** Folders whose contents the app makes again: temporary files, caches and logs. */
export const REMADE_FOLDERS = new Set([
  'tmp', '.tmp', 'temp', '.temp', 'cache', '.cache', 'caches', 'code cache', 'gpucache', 'shadercache',
  'dawncache', 'grshadercache', 'log', 'logs', 'crashpad', 'crashes'
]);

/** The dot-folders AI coding tools keep in the home folder. */
export const AI_APP_HOMES = ['claude', 'codex', 'cursor', 'gemini', 'windsurf', 'codeium', 'continue', 'kiro', 'trae', 'aider'];

const homeSegment = `/\\.(?:${AI_APP_HOMES.join('|')})/`;

/** What a folder that people keep things in holds, by its name. */
const KEPT_DESCRIPTIONS = {
  skills: 'Skills you added to the app',
  agents: 'Agents you defined for the app',
  commands: 'Commands you defined for the app',
  memory: 'Memory the app keeps for you',
  rules: 'Rules you set for the app',
  prompts: 'Prompts you saved in the app',
  backups: 'Backups the app made of your settings',
  backup: 'Backups the app made of your settings'
};

/**
 * For a '/'-separated lower-case path: the kept folder right below an AI app's home folder
 * (`~/.claude/skills/...` gives 'skills'), or null.
 */
export function keptFolderInAppHome(lowerPath) {
  const m = new RegExp(`${homeSegment}([^/]+)/`).exec(lowerPath);
  return m && KEPT_DESCRIPTIONS[m[1]] ? m[1] : null;
}

export function keptFolderDescription(name) {
  return KEPT_DESCRIPTIONS[name] || null;
}

/** True for a file directly in an AI app's home folder (`~/.claude/x.json`): its settings and state. */
export function isAppHomeTopLevelFile(lowerPath) {
  return new RegExp(`${homeSegment}[^/]+$`).test(lowerPath);
}
