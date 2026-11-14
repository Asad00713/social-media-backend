// Jest transform for CommonJS dependencies that load a module with `import()`.
//
// Jest runs CommonJS in a vm context and rejects a real `import()` unless the
// whole suite runs under --experimental-vm-modules. @react-email/render loads
// react-dom/server that way, so every email spec would fail. This rewrites
// `import("x")` to `Promise.resolve(require("x"))` in the files that the
// package.json "transform" key points here. Production (plain Node) runs the
// dependency unchanged.
const { createHash } = require('node:crypto');

const VERSION = '1';
const DYNAMIC_IMPORT = /\bimport\((["'][^"']+["'])\)/g;

module.exports = {
  process(sourceText) {
    return {
      code: sourceText.replace(DYNAMIC_IMPORT, 'Promise.resolve(require($1))'),
    };
  },
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha256')
      .update(VERSION)
      .update(sourcePath)
      .update(sourceText)
      .digest('hex');
  },
};
