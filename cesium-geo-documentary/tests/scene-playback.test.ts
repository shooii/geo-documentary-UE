import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const studioSource = () => readFile(new URL('../apps/studio/public/studio.js', import.meta.url), 'utf8');

test('编辑器保留单场景与连续播放入口，暂停使用独立状态', async () => {
  const studio = await studioSource();
  assert.match(studio, /function startPlaybackFromSelected\(\{ continuous = false \} = \{\}\)/);
  assert.match(studio, /if \(!state\.playbackContinuous\) return stopPlayback\(\{ completed: true \}\);/);
  assert.match(studio, /startPlaybackFromSelected\(\{ continuous: true \}\)/);
  assert.match(studio, /if \(continuePlaying\) startPlaybackFromSelected\(\{ continuous \}\)/);
  assert.match(studio, /state\.playbackStatus === "playing"\) return pausePlayback\(\)/);
  assert.match(studio, /state\.playbackStatus === "paused"\) return resumePlayback\(\)/);
  assert.doesNotMatch(studio, /"play-scene-range"/);
});

test('字幕、旁白延迟与素材门闩使用同一个可暂停时钟', async () => {
  const studio = await studioSource();
  for (const field of ['narrationStartTimer', 'previewAssetRevealTimer', 'previewAssetHideTimer', 'playTimer']) {
    assert.match(studio, new RegExp(`state\\.${field} = playbackClock\\.setTimeout`));
    assert.doesNotMatch(studio, new RegExp(`state\\.${field} = setTimeout`));
  }
  assert.match(studio, /state\.subtitleTimers = \[playbackClock\.setTimeout\(tick, 30\)\]/);
  assert.match(studio, /event\.data\.playbackEpoch !== state\.playbackEpoch/);
});

test('无音频fallback持续轮询素材进度，不再丢失整段剩余计时', async () => {
  const studio = await studioSource();
  assert.match(studio, /const elapsed = playbackClock\.now\(\) - startedAt/);
  assert.match(studio, /if \(stalled && elapsed >= estimatedMs\) return advance\(\)/);
  assert.match(studio, /syncPlaybackStage\(scene, playbackProgress/);
  assert.match(studio, /audio\.currentTime \|\| 0\) \+ 0\.02 >= Number\(range\.end \|\| 0\)/);
});
