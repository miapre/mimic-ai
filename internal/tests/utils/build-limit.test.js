'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recordBuildLimitHit, clearBuildLimitEpisode } = require('../../../src/utils/build-limit');

const MAX = 300;

describe('build-limit circuit breaker accounting', () => {
  it('counts a single episode once no matter how many times the cap fires before a report', () => {
    const session = {};
    const a = recordBuildLimitHit(session, MAX);
    const b = recordBuildLimitHit(session, MAX);
    const c = recordBuildLimitHit(session, MAX);
    assert.equal(a.buildLimitHits, 1);
    assert.equal(b.buildLimitHits, 1, 'repeated cap hits within one episode do not inflate the count');
    assert.equal(c.buildLimitHits, 1);
    assert.equal(a.repeat, false);
    assert.match(a.message, /Generate the report/);
  });

  it('escalates on the SECOND episode — report reset is not a free pass', () => {
    const session = {};
    const first = recordBuildLimitHit(session, MAX);
    assert.equal(first.repeat, false);

    // A report ends the episode (resets per-build counter + clears the latch).
    clearBuildLimitEpisode(session);

    const second = recordBuildLimitHit(session, MAX);
    assert.equal(second.buildLimitHits, 2, 'cumulative hits persist across reports');
    assert.equal(second.repeat, true);
    assert.match(second.message, /NOT a free reset/);
    assert.match(second.message, /STOP and confirm with the user/);
    assert.match(second.message, /~600 Phase-3 tool calls/);
  });

  it('keeps escalating on a third episode', () => {
    const session = {};
    recordBuildLimitHit(session, MAX); clearBuildLimitEpisode(session);
    recordBuildLimitHit(session, MAX); clearBuildLimitEpisode(session);
    const third = recordBuildLimitHit(session, MAX);
    assert.equal(third.buildLimitHits, 3);
    assert.equal(third.repeat, true);
    assert.match(third.message, /~900 Phase-3 tool calls/);
  });
});
