/** All BDScript functions. Importing this module registers them. */
import "./core";
import "./text";
import "./mathfn";
import "./timefn";
import "./variables";
import "./embeds";
import "./components";
import "./jsonhttp";
import "./messages";
import "./people";
import "./server";
import "./botinfo";
import { registerUncached } from "./extra";
import { registerAliases } from "./vectorfns";

registerUncached();
registerAliases();
