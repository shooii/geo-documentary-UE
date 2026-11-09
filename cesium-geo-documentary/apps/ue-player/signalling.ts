import { SignallingServer, InitLogging } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.7';
import { resolve } from 'node:path';
InitLogging({ logDir:resolve('workspace/ue-logs'), logLevelConsole:'info', logLevelFile:'info' });
const server = new SignallingServer({
  streamerPort:Number(process.env.UE_STREAMER_PORT || 8889),
  playerPort:Number(process.env.UE_SIGNALLING_PORT || 8888),
  streamerWsOptions:{host:'127.0.0.1'},
  playerWsOptions:{host:'127.0.0.1'},
  peerOptions:{iceServers:[]},
  maxSubscribers:Number(process.env.UE_MAX_SUBSCRIBERS || 1),
  // A player whose socket died without a close frame (closed panel, killed tab,
  // sleeping laptop) otherwise keeps the single subscriber slot forever and every
  // later page waits on "正在连接" with no way out.
  playerKeepaliveTimeout:Number(process.env.UE_PLAYER_KEEPALIVE_MS || 15000)
});

// One UE instance serves exactly one controller, and the newest controller wins. Pages
// that are closed, hidden behind the panel or simply forgotten never told us they were
// done, so the slot has to be handed over on arrival. The slot is released synchronously
// (the websocket close is async) so the newcomer's very first subscribe lands on a free
// streamer instead of racing the disconnect.
server.playerRegistry.on('added', (playerId: string) => {
  for (const other of server.playerRegistry.listPlayers()) {
    if (other.playerId === playerId || !other.subscribedStreamer) continue;
    other.subscribedStreamer.subscribers.delete(other.playerId);
    console.log(`UE_PLAYER_TAKEOVER ${other.playerId} -> ${playerId}`);
    other.protocol.disconnect(4000, 'replaced by a newer controller');
  }
});

console.log('UE_SIGNALLING_STARTED (loopback, one controller per UE instance, newest controller wins)');
void server;
