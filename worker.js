// Search worker: its own engine instance replays the game and thinks, so the board stays responsive.
let ex = null, lastLayout = -1;

const ready = (async () => {
  const bytes = await (await fetch('engine.wasm?v=25')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, { env: { now: () => performance.now() } });
  ex = instance.exports;
  ex.init();
})();

onmessage = async e => {
  await ready;
  const { id, layout, moves, ms, depth } = e.data;
  if (layout !== lastLayout) { ex.clearHash(); lastLayout = layout; }
  ex.newGame(layout);
  for (const m of moves) ex.play(m);
  const best = ex.think(ms, depth || 0);
  postMessage({ id, best, score: ex.infoScore(), depth: ex.infoDepth(), nodes: ex.infoNodes() });
};
