#!/usr/bin/env node
// Placeholder for the nummo command-line tool (`nummo push`, `nummo verify`).
console.log(`nummo ${process.env.npm_package_version ?? ""}`.trim());
console.log("The nummo CLI is not released yet. It will push your pricing config and check");
console.log("your billing records against the chain. Follow https://github.com/ommgh/nummo");
