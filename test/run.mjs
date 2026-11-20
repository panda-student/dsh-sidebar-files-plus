/**
 * Run every behavior suite in one process.
 *
 * `node --test test/` is the idiomatic entry, but it spawns a child process per
 * file, which the DSH workspace sandbox blocks (spawn EPERM). Importing the
 * suites keeps the same `node:test` reporting without spawning anything, so the
 * suite stays runnable in the confined environment where the plugin is built.
 */
import './gestures.test.mjs';
import './find.test.mjs';
import './perf.test.mjs';
import './selection-perf.test.mjs';
import './leak.test.mjs';
