'use strict';

/**
 * Passenger entry point for the ad-frame subdomain.
 *
 * Copy this to the application root of a second Node.js app (e.g. the one
 * serving ads.<yourdomain>) and set that app's startup file to it. It does not
 * need its own checkout or its own node_modules: it requires the main
 * installation's server, which keeps roughly a quarter of a gigabyte of native
 * modules off a shared-hosting disk quota and, more usefully, guarantees the
 * two processes are always running the same code.
 *
 * Why a whole second app exists at all: ad tags refuse to render without
 * localStorage, localStorage needs a real origin, and a real origin sharing the
 * site's hostname would let ad script call the API as the signed-in reader.
 * A subdomain is a different origin, so the frames fill and still cannot reach
 * the site. See the long comment in src/ads.js.
 *
 * Set AFTERDARK_ROOT in this app's environment to the main app's root, plus:
 *   ADS_ONLY=1  SITE_ORIGIN=https://<yourdomain>  SESSION_SECRET=<any value>
 */

const path = require('node:path');
const os = require('node:os');

// This instance serves ad frames only — never a second copy of the site.
process.env.ADS_ONLY = '1';
process.env.CLUSTER = '1';
process.env.WIRE_AUTO = '0';

const root = process.env.AFTERDARK_ROOT || path.join(os.homedir(), 'afterdark');

module.exports = require(path.join(root, 'server.js'));
