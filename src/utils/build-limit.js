'use strict';

/**
 * Circuit-breaker accounting for the Phase-3 tool-call cap.
 *
 * The build report resets the per-build Phase-3 tool-call counter (a
 * legitimate checkpoint — it ends "a build"). Without cumulative tracking,
 * that reset let an agent hit the cap, generate a report, and silently start
 * another full MAX-call batch indefinitely — so the cap, meant as a "this
 * build is too large or stuck, involve the user" signal, became a free reset.
 *
 * recordBuildLimitHit counts distinct cap *episodes* on the session and
 * escalates the message on repeats, so continuing past the cap becomes an
 * explicit, surfaced decision instead of a silent default. It mutates the
 * session: buildLimitHits (+1 once per episode) and _buildLimitActive (a latch
 * held until the next report clears it via clearBuildLimitEpisode).
 */
function recordBuildLimitHit(session, max) {
  if (!session._buildLimitActive) {
    session._buildLimitActive = true;
    session.buildLimitHits = (session.buildLimitHits || 0) + 1;
  }
  const hits = session.buildLimitHits || 1;
  const repeat = hits >= 2;
  const message = repeat
    ? `Build limit hit again — episode ${hits} (~${max * hits} Phase-3 tool calls this session). `
      + `Generating another report and continuing is NOT a free reset: this build is too large or `
      + `stuck. STOP and confirm with the user how to proceed (split the screen into multiple builds, `
      + `cut scope, or fix whatever is looping) before building further. You may generate the report `
      + `to checkpoint what exists, but do not silently start another ${max}-call batch.`
    : `${max} tool calls in build phase. This build is too large or stuck. Generate the report with `
      + `mimic_generate_build_report and assess what was built so far before continuing.`;
  return { error: 'BUILD_LIMIT_REACHED', buildLimitHits: hits, repeat, message };
}

/**
 * Clear the active-episode latch so the next time the cap trips it counts as a
 * new episode. Called by the build report when it resets the Phase-3 counter.
 */
function clearBuildLimitEpisode(session) {
  session._buildLimitActive = false;
}

module.exports = { recordBuildLimitHit, clearBuildLimitEpisode };
