// Copy the built cdylib next to native/index.js as vector_sdk_js.<platform>-<arch>.node
const fs = require("fs");
const path = require("path");
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "native", "target");
const names = { linux: "libvector_sdk_js.so", darwin: "libvector_sdk_js.dylib", win32: "vector_sdk_js.dll" };
const src = path.join(target, "release", names[process.platform]);
const dst = path.join(__dirname, "..", "native", `vector_sdk_js.${process.platform}-${process.arch}.node`);
fs.copyFileSync(src, dst);
console.log(`native addon -> ${path.relative(process.cwd(), dst)}`);
