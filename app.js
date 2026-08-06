'use strict';

/**
 * Entry point for cPanel's Node.js Application Manager (Phusion Passenger).
 *
 * Passenger is not just "node server.js with a proxy in front" — it owns the
 * process lifecycle, so two of this app's defaults are wrong under it and are
 * corrected here rather than left to whoever fills in the environment form.
 *
 * The startup file in the Node.js App setup screen should be `app.js`, and the
 * application root the directory this file sits in.
 */

// 1. Passenger spawns and reaps its own workers, and scales them by demand.
//    node:cluster forking underneath that gives two supervisors fighting over
//    the same sockets, and Passenger will restart what it did not start.
process.env.CLUSTER = '1';

// 2. Passenger stops an idle application and starts it again on the next
//    request. In-process setInterval schedulers therefore run only while
//    somebody happens to be reading the site, which is precisely when a news
//    wire looks like it is working and is not. Ingestion moves to cron:
//
//      */10 * * * *  cd ~/<app-root> && node scripts/cron-tick.js >> ~/logs/wire.log 2>&1
//
//    Set WIRE_AUTO=1 in the environment to override this and go back to
//    in-process polling.
if (!process.env.WIRE_AUTO) process.env.WIRE_AUTO = '0';

// Requiring the server starts it. Passenger patches http.Server#listen, so the
// app's own app.listen(PORT) binds to Passenger's socket instead of a TCP port.
module.exports = require('./server.js');
