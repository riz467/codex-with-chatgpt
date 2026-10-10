"""Build an immutable deployment bundle from a committed source and previously verified public capsule."""
import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import archive_tree,canonical,elf_dependencies,inventory,put,require,sha,verify_archive

def pack(repo,capsule,out):
    require(not out.exists(),'FRESH_OUTPUT_REQUIRED');out.mkdir(parents=True)
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
    require(not subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip(),'COMMITTED_SOURCE_REQUIRED')
    manifest=json.loads((capsule/'CAPSULE-MANIFEST.json').read_text());image=capsule/'runtime'
    require(sha(canonical(inventory(image)).encode())==manifest['inventorySha256'],'PUBLIC_CAPSULE_INVENTORY')
    shutil.copyfile(capsule/'capsule.tar',out/'capsule.tar');verify_archive(out/'capsule.tar',sha((out/'capsule.tar').read_bytes()))
    host=out/'host-runtime';host.mkdir();queue=[image/'usr/bin/node'];seen=set()
    libraries={p.name:p for p in image.rglob('*') if p.is_file() and any(part in p.parts for part in ['lib','lib64'])}
    while queue:
        p=queue.pop();rel=p.relative_to(image).as_posix()
        if rel in seen:continue
        seen.add(rel);data=p.read_bytes();put(host,rel,data,0o755)
        needed,interp=elf_dependencies(data)
        for lib in needed+([interp] if interp else []):
            target=image/lib.lstrip('/') if lib.startswith('/') else libraries.get(lib)
            require(target is not None and target.is_file(),'HOST_ELF_CLOSURE');queue.append(target)
            if not lib.startswith('/'):
                put(host,'lib/x86_64-linux-gnu/'+lib,target.read_bytes(),0o755)
    zod=image/'runtime/node_modules/zod'
    for p in zod.rglob('*'):
        if p.is_file():put(host,p.relative_to(image).as_posix(),p.read_bytes())
    archive_tree(host,out/'host-runtime.tar')
    src=out/'source';src.mkdir();(src/'node_modules').mkdir()
    archived=subprocess.check_output(['git','archive','--format=tar',commit,'src','tests','scripts','package.json','pnpm-lock.yaml','vitest.config.ts'],cwd=repo)
    with tarfile.open(fileobj=io.BytesIO(archived)) as t:
        for m in t:
            require(m.isfile() or m.isdir(),'GIT_SOURCE_SPECIAL')
            if m.isdir():(src/m.name).mkdir(parents=True,exist_ok=True)
            else:put(src,m.name,t.extractfile(m).read(),m.mode)
    # Isolated compile from committed source and SHA-verified public dependency closure, never ignored repo/dist.
    build=out/'isolated-build';shutil.copytree(src,build)
    shutil.copytree(image/'runtime/node_modules',build/'node_modules',dirs_exist_ok=True)
    config=subprocess.check_output(['git','show',commit+':tsconfig.json'],cwd=repo);(build/'tsconfig.json').write_bytes(config)
    require(manifest['dependencies']['lockfileSha256']==sha((src/'pnpm-lock.yaml').read_bytes()),'CAPSULE_SOURCE_LOCK_MISMATCH')
    node_cwd=str(build).removeprefix('\\\\?\\') if os.name=='nt' else str(build)
    subprocess.run(['node','node_modules/typescript/bin/tsc','-p','tsconfig.json'],cwd=node_cwd,check=True,timeout=180)
    subprocess.run(['node','scripts/copy-runtime.mjs'],cwd=node_cwd,check=True,timeout=30)
    for p in (build/'dist').rglob('*'):
        require(not p.is_symlink(),'DIST_ALIAS')
        if p.is_file():put(src,'dist/'+p.relative_to(build/'dist').as_posix(),p.read_bytes())
    archive_tree(src,out/'raw-source.tar');rawSha=sha((out/'raw-source.tar').read_bytes());rows=inventory(src)
    (src/'SOURCE-MANIFEST.json').write_text(canonical({'sourceCommit':commit,'sourceArchiveSha256':rawSha,'files':rows})+'\n')
    archive_tree(src,out/'source.tar')
    assets=['deploy.py','capsule.py','evidence.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py']
    for name in assets:shutil.copyfile(repo/'scripts/linux-qualification'/name,out/name)
    pins={'sourceCommit':commit,'sourceArchiveSha256':rawSha,'runtimeCapsuleSha256':manifest['inventorySha256']}
    names=['capsule.tar','host-runtime.tar','raw-source.tar','source.tar',*assets]
    hashes={name:sha((out/name).read_bytes()) for name in names}
    release={'schema':1,'targetVmids':[116,117],'sourcePins':pins,'hostRuntimeInventorySha256':sha(canonical(inventory(host)).encode()),
      'sourceInventorySha256':sha(canonical(rows).encode()),'files':hashes,'authority':'NONE','productionDispatch':'CLOSED',
      'buildProvenance':{'kind':'ISOLATED_COMMITTED_SOURCE_COMPILE','commit':commit,'lockfileSha256':sha((src/'pnpm-lock.yaml').read_bytes()),
        'compiledFilesSha256':{p.relative_to(build/'dist').as_posix():sha(p.read_bytes()) for p in (build/'dist').rglob('*') if p.is_file()}},
       'linux13Suite':'NOT_RUN','namespaceLiveProof':'NOT_RUN','providerQualification':'NOT_RUN','semanticReview':'NOT_RUN',
       'liveReadiness':'LIVE_BLOCKED_EXTERNAL_FENCING_UNIMPLEMENTED',
      'credentialScope':'Fresh per-campaign broker/client/TLS keys outside workload image; not Human signing authority'}
    (out/'DEPLOYMENT-PACKAGE.json').write_text(canonical(release)+'\n');print(json.dumps({'sourceCommit':commit,'packageSha256':sha((out/'DEPLOYMENT-PACKAGE.json').read_bytes()),'files':len(hashes)}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('repo',type=Path);p.add_argument('capsule',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
    if os.name=='nt':a.capsule=Path('\\\\?\\'+str(a.capsule.resolve()));a.output=Path('\\\\?\\'+str(a.output.resolve()))
    pack(a.repo,a.capsule,a.output)
