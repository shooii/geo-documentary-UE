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

// One UE instance serves exactly one controller, and the controller that is already
// watching keeps it. The old policy handed the slot to whoever arrived last, which
// made two open studio tabs evict each other in a loop. Contention is resolved one
// layer up, in the player's viewer lease (/api/viewer-slot): the holder keeps the
// slot, later windows show "实例正在占用" and join by themselves once it is released.
// Here we only report a second subscriber so the log still explains a stuck window.
server.playerRegistry.on('added', (playerId: string) => {
  for (const other of server.playerRegistry.listPlayers()) {
    if (other.playerId === playerId || !other.subscribedStreamer) continue;
    console.log(`UE_PLAYER_BUSY ${playerId} waits for ${other.playerId} (one controller per UE instance)`);
  }
});

console.log('UE_SIGNALLING_STARTED (loopback, one controller per UE instance, first viewer keeps it)');
void server;
