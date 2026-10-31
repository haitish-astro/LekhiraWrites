// Lekhira Writes: runs the same end-to-end tests against Postgres instead of SQLite.
//   npm run test:pg                       a throwaway Postgres (PGlite) inside this process
//   TEST_DATABASE_URL=postgres://… npm run test:pg   a real server (CI uses one); its tables get
//                                                    created, so never point this at production
'use strict';
(async () => {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const port = Number(process.env.TEST_PG_PORT) || 54391;
    const pg = await PGlite.create();
    await new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' }).start();
    process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    // PGlite is a single Postgres session, so share one connection: a transaction then can't
    // pick up another request's queries.
    process.env.DATABASE_POOL = '1';
  }
  console.log('\nOn Postgres');
  require('./run.js');
})();
