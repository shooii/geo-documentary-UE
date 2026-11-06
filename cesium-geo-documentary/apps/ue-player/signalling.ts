import { SignallingServer, InitLogging } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.7';
import { resolve } from 'node:path';
InitLogging({ logDir:resolve('workspace/ue-logs'), logLevelConsole:'info', logLevelFile:'info' });
const server = new SignallingServer({ streamerPort:Number(process.env.UE_STREAMER_PORT || 8889), playerPort:Number(process.env.UE_SIGNALLING_PORT || 8888), streamerWsOptions:{host:'127.0.0.1'}, playerWsOptions:{host:'127.0.0.1'}, peerOptions:{iceServers:[]}, maxSubscribers:1 });
console.log('UE_SIGNALLING_STARTED (loopback, one controller per UE instance)');
void server;
