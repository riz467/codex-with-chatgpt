// Reuses the VM116 dependency-closure algorithm. No npm lifecycle scripts or candidate execution.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.resolve(process.argv[2]);
if(![3,4].includes(process.argv.length)||fs.existsSync(out))throw new Error('FRESH_OUTPUT_REQUIRED');
const cache=process.argv[3]?path.resolve(process.argv[3]):null;
const cacheManifest=cache?JSON.parse(fs.readFileSync(path.join(cache,'DEPENDENCIES.json'))):null;
fs.mkdirSync(out,{recursive:true});
const packages=new Map(),selected=new Map(),excludedForeign=[],layout={};
const lock=fs.readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8'),integrities=new Map();
for(const m of lock.matchAll(/^  '?([^'\r\n]+)'?:\r?\n    resolution: \{integrity: (sha512-[^,}\r\n]+)/gm))integrities.set(m[1],m[2]);
function collect(dir){
  dir=fs.realpathSync(dir);const p=JSON.parse(fs.readFileSync(path.join(dir,'package.json'))),id=`${p.name}@${p.version}`;
  if(packages.has(id))return id;
  if(p.os && !p.os.includes('linux') || p.cpu && !p.cpu.includes('x64'))throw new Error(`NON_LINUX_PACKAGE:${id}`);
  const info={name:p.name,version:p.version,dir,deps:{},lifecycleNotExecuted:true};packages.set(id,info);
  if(!selected.has(p.name))selected.set(p.name,id);
  for(const dep of Object.keys(p.dependencies||{})){
    let parent=dir,found;
    for(;;){const candidate=path.join(parent,'node_modules',dep);if(fs.existsSync(path.join(candidate,'package.json'))){found=candidate;break;}
      const next=path.dirname(parent);if(next===parent)break;parent=next;}
    if(!found)throw new Error(`DEPENDENCY_MISSING:${dep}`);info.deps[dep]=collect(found);
  }return id;
}
const project=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
for(const name of [...Object.keys(project.dependencies),...Object.keys(project.devDependencies)]){
  const id=collect(path.join(root,'node_modules',name));selected.set(name,id);
}
fs.mkdirSync(path.join(out,'public-archives'));
const ids=[...packages.keys()];let cursor=0;
await Promise.all(Array.from({length:6},async()=>{
  while(cursor<ids.length){
    const id=ids[cursor++],p=packages.get(id),integrity=integrities.get(id);
    if(!integrity)throw new Error(`COMMITTED_LOCK_INTEGRITY_MISSING:${id}`);
    const basename=p.name.split('/').at(-1),url=`https://registry.npmjs.org/${p.name}/-/${basename}-${p.version}.tgz`;
    let bytes;
    const cached=cacheManifest?.publicArchives?.[id];
    if(cached && cached.integrity===integrity)bytes=fs.readFileSync(path.join(cache,cached.file));
    else{const response=await fetch(url);if(!response.ok)throw new Error(`PUBLIC_PACKAGE_DOWNLOAD:${id}`);bytes=Buffer.from(await response.arrayBuffer());}
    if(`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`!==integrity)throw new Error(`LOCK_INTEGRITY_MISMATCH:${id}`);
    p.archiveSha256=crypto.createHash('sha256').update(bytes).digest('hex');p.integrity=integrity;p.archiveFile=`public-archives/${p.archiveSha256}.tgz`;
    fs.writeFileSync(path.join(out,p.archiveFile),bytes,{flag:'wx'});
  }
}));
function copy(dir,target){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules')continue;const src=path.join(dir,entry.name),dst=path.join(target,entry.name);
    const normalized=src.replaceAll('\\','/');
    if(/\/prebuilds\//.test(normalized) && !/\/prebuilds\/linux-x64(?:\/|$)/.test(normalized)){excludedForeign.push(path.relative(root,src).replaceAll('\\','/'));continue;}
    if(entry.isSymbolicLink())throw new Error('PACKAGE_SYMLINK');
    if(entry.isDirectory()){fs.mkdirSync(dst,{recursive:true});copy(src,dst);}
    else if(entry.isFile()){
      if(/\.(exe|dll|dylib)$/i.test(entry.name)){excludedForeign.push(path.relative(root,src).replaceAll('\\','/'));continue;}
      const header=fs.readFileSync(src).subarray(0,24);
      if(header.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])) && (header[4]!==2 || header[5]!==1 || header.readUInt16LE(18)!==62)){
        excludedForeign.push(path.relative(root,src).replaceAll('\\','/'));continue;
      }
      if(/\.node$/i.test(entry.name) && !fs.readFileSync(src).subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])))throw new Error(`NON_LINUX_NATIVE_FILE:${src}`);
      fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);
    }else throw new Error('SPECIAL_FILE');
  }
}
function emit(id,target,ancestors=[]){
  if(ancestors.includes(id))throw new Error('NESTED_CYCLE');const p=packages.get(id);
  layout[path.relative(out,target).replaceAll('\\','/')]=id;
  for(const [name,dep]of Object.entries(p.deps))if(selected.get(name)!==dep)emit(dep,path.join(target,'node_modules',name),[...ancestors,id]);
}
for(const [name,id]of selected)emit(id,path.join(out,'runtime/node_modules',name));
// Explicit Linux optional binaries. Versions derive from the exact installed parent, not latest tags.
const native=[];
for(const [parent,name]of [...packages].filter(([,p])=>['rollup','esbuild'].includes(p.name)).map(([id,p])=>[id,p.name==='rollup'?'@rollup/rollup-linux-x64-gnu':'@esbuild/linux-x64'])){
  const parentPkg=packages.get(parent);if(!parentPkg)throw new Error(`NATIVE_PARENT_MISSING:${parent}`);
  const version=parentPkg.version,url=`https://registry.npmjs.org/${name.replace('/','%2f')}/${version}`;
  const response=await fetch(url);if(!response.ok)throw new Error('NPM_METADATA');const p=await response.json();
  if(p.name!==name||p.version!==version||!/^https:\/\/registry\.npmjs\.org\//.test(p.dist.tarball)||p.dist.integrity!==integrities.get(`${name}@${version}`))throw new Error('NPM_COMMITTED_LOCK_PIN');
  const download=await fetch(p.dist.tarball);if(!download.ok)throw new Error('NPM_ARTIFACT');const bytes=Buffer.from(await download.arrayBuffer());
  if(`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`!==p.dist.integrity)throw new Error('NPM_INTEGRITY');
  const filename=name.replaceAll('/','-').replace('@','')+'-'+version+'.tgz';fs.writeFileSync(path.join(out,filename),bytes,{flag:'wx'});
  const targets=Object.entries(layout).filter(([,id])=>id===parent).map(([target])=>`${target}/node_modules/${name}`);
  native.push({name,version,file:filename,targets,integrity:p.dist.integrity,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),url:p.dist.tarball});
}
const manifest={schema:1,lockfileSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'pnpm-lock.yaml'))).digest('hex'),
  packages:Object.fromEntries([...packages].map(([id,p])=>[id,p.deps])),publicArchives:Object.fromEntries([...packages].map(([id,p])=>[id,{name:p.name,version:p.version,
    file:p.archiveFile,sha256:p.archiveSha256,integrity:p.integrity,dependencies:p.deps}])),layout,native,excludedForeign,lifecycleScriptsExecuted:false};
fs.writeFileSync(path.join(out,'DEPENDENCIES.json'),JSON.stringify(manifest,null,2)+'\n');
execFileSync('python',['-I','-B',path.join(root,'scripts/linux-qualification/pack-public-packages.py'),out],{stdio:'inherit'});
console.log(JSON.stringify({out,packages:packages.size,native:native.map(p=>`${p.name}@${p.version}`)}));
