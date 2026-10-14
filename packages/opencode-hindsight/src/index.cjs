// CJS entry — wraps the ESM build for require() compatibility.
// OpenCode CLI uses require() for npm packages; this exports
// a PluginModule-compatible object: { server: pluginFunction }.

const mod = require("./index.js");
const plugin = mod.default || mod.HindsightPlugin;
module.exports = { server: plugin };
module.exports.default = plugin;
module.exports.HindsightPlugin = plugin;
