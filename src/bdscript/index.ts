/** BDScript (Bot Designer for Discord / D.js-BDscript) for Vector. */
import "./functions";
export { BDBot, Command, CommandManager, type BDBotOptions, type AiFunction } from "./bot";
export { BDScript, Result, type RunOptions } from "./engine";
export { Context, Response } from "./context";
export { compileCode, run, evaluate, FunctionError } from "./interpreter";
export { ParseError, escape, unescape } from "./parser";
export { FUNCTIONS, BDScriptError, StopExecution, fn, alias } from "./registry";
export { Storage } from "./storage";
export { BDBot as Bot } from "./bot";
