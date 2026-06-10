/**
 * Test entrypoint. Importing each *.test.ts module registers its suites with
 * the harness (side effect); runAll() then executes everything and sets the
 * process exit code.
 *
 *   npx tsx test/run.ts
 */

import "./runs/lifetimes";
import "./runs/resolution";
import "./runs/scopes";
import "./runs/async";
import "./runs/disposal";
import "./runs/lifecycle";
import "./runs/errors";
import "./runs/modules";
import "./runs/concurrency";
import "./runs/accessors";
import { runAll } from "./harness";

void runAll();
