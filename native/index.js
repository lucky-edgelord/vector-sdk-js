// Loads the prebuilt addon for this platform. Set VECTOR_SDK_NATIVE to a .node path to override.
const path = require("path");
const file = process.env.VECTOR_SDK_NATIVE || path.join(__dirname, `vector_sdk_js.${process.platform}-${process.arch}.node`);
module.exports = require(file);
