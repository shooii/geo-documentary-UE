import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
const root=resolve(process.cwd()),runtimeFile=join(root,'workspace/ue-runtime.json');
let runtime:{engineRoot:string;project:string};
try{runtime=JSON.parse((await readFile(runtimeFile,'utf8')).replace(/^\uFEFF/,''));}catch{throw new Error('Run pnpm ue:build to compile and prepare the native UE renderer first.');}
const tsx=join(root,'node_modules/tsx/dist/cli.mjs'),children:ChildProcess[]=[];
const start=(exe:string,args:string[])=>{const child=spawn(exe,args,{cwd:root,windowsHide:true,stdio:'inherit'});children.push(child);child.on('error',error=>{console.error(error);cleanup();process.exitCode=1;});return child;};
function cleanup(){for(const p of children)if(p.exitCode===null)p.kill();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{cleanup();process.exit(0);});
start(process.execPath,[tsx,'apps/ue-player/signalling.ts']);
start(join(runtime.engineRoot,'Engine/Binaries/Win64/UnrealEditor.exe'),[runtime.project,'/Engine/Maps/Entry','-game','-RenderOffscreen','-Unattended','-NoSplash','-AudioMixer',`-PixelStreamingURL=ws://127.0.0.1:${process.env.UE_STREAMER_PORT || 8889}`,'-ResX=1080','-ResY=1920','-ForceRes']);
const studio=start(process.execPath,[tsx,'apps/studio/server.ts']);
studio.on('exit',code=>{cleanup();process.exitCode=code || 0;});
