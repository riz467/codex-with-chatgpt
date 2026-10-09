"""Public-input minimal image builder + closed archive verifier. Never copy guest/host /etc, HOME or secrets.
No apt/npm install, lifecycle, ELF execution or candidate code. Non-symlink portable images; fixed inputs
are approved by artifact SHA after build. Uses platform libarchive only to decode zstd Debian tar data.
"""
import argparse
import hashlib
import io
import json
import os
import re
import struct
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

def sha(data): return hashlib.sha256(data).hexdigest()
def file_sha(file):
    with file.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def require(ok,reason):
    if not ok: raise ValueError(reason)
def portable(name):
    require(isinstance(name,str) and 0<len(name)<=240 and '\\' not in name and ':' not in name,'PATH')
    parts=PurePosixPath(name).parts
    require(not name.startswith('/') and all(p not in ['', '.', '..'] and not p.endswith(('.', ' ')) for p in name.split('/')),'PATH')
    require(all(not re.match(r'(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)',p) for p in parts),'PATH_ALIAS')
    return name
def secret_scan(name,data):
    require(not any(p.lower() in ['.ssh','.aws','.azure','.kube','auth.json','.env','.git-credentials','.npmrc','id_rsa','id_ed25519'] for p in name.split('/')),'SECRET_PATH')
    require(not re.search(rb'(?m)^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{128,}-----END',data),'PRIVATE_KEY_MATERIAL')
    require(not re.search(rb'(?m)^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|PVE_TOKEN_SECRET)\s*=\s*\S+',data),'SECRET_ASSIGNMENT')
def inventory(root):
    rows=[]
    def visit(directory):
        for p in sorted(directory.iterdir(),key=lambda p:p.name):
            require(not p.is_symlink(),'IMAGE_SYMLINK');rel=portable(p.relative_to(root).as_posix())
            if p.is_dir(): rows.append({'path':rel,'kind':'DIRECTORY'});visit(p)
            else:
                require(p.is_file(),'SPECIAL_FILE');data=p.read_bytes();require(len(data)<=128*1024*1024,'FILE_LIMIT')
                secret_scan(rel,data);rows.append({'path':rel,'kind':'FILE','sha256':sha(data),'bytes':len(data)})
        require(len(rows)<50000,'IMAGE_LIMIT')
    visit(root);return rows
def tar_entries(data):
    result={}
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:*') as t:
        for m in t:
            name='/'.join(p for p in m.name.removeprefix('./').rstrip('/').split('/') if p!='.')
            if not name or name=='.': continue
            portable(name)
            require(m.isfile() or m.isdir() or m.issym() or m.islnk(),'SPECIAL_ARCHIVE_ENTRY')
            require(m.size<=128*1024*1024,'ARCHIVE_FILE_LIMIT')
            value=(t.extractfile(m).read() if m.isfile() else None,m.linkname if m.issym() or m.islnk() else None,m.mode,m.islnk())
            if name in result:require(result[name]==value,'CONFLICTING_PUBLIC_ARCHIVE_DUPLICATE')
            else:result[name]=value
    return result
def ar_data(data):
    require(data[:8]==b'!<arch>\n','DEB_AR');at=8
    while at+60<=len(data):
        header=data[at:at+60];require(header[58:]==b'`\n','DEB_HEADER');size=int(header[48:58]);name=header[:16].decode().strip().rstrip('/')
        content=data[at+60:at+60+size];require(len(content)==size,'DEB_TRUNCATED')
        if name.startswith('data.tar'): return name,content
        at+=60+size+(size%2)
    raise ValueError('DEB_DATA_MISSING')
def deb_entries(file,scratch):
    name,data=ar_data(file.read_bytes())
    if name.endswith('.zst'):
        compressed=scratch/(sha(data)+'.tar.zst');compressed.write_bytes(data)
        p=subprocess.run(['tar','-cf','-','--format=pax','@'+str(compressed)],capture_output=True,timeout=120)
        require(p.returncode==0,'LIBARCHIVE_ZSTD');data=p.stdout
    return tar_entries(data)
def resolve(entries,name,seen=None):
    seen=set() if seen is None else seen;require(name not in seen and name in entries,'LINK_MISSING_OR_CYCLE');seen.add(name)
    data,link,mode,hard=entries[name]
    if link:
        raw=(PurePosixPath(link) if hard or link.startswith('/') else PurePosixPath(name).parent/link).as_posix().lstrip('/')
        parts=[]
        for p in raw.split('/'):
            if p=='..':require(bool(parts),'LINK_ESCAPE');parts.pop()
            elif p not in ['','.']:parts.append(p)
        return resolve(entries,'/'.join(parts),seen)
    require(data is not None,'LINK_NOT_FILE');return data,mode
def elf_dependencies(data):
    if not data.startswith(b'\x7fELF'): return [],None
    require(data[4:6]==b'\x02\x01','ELF_X64_LE');require(struct.unpack_from('<H',data,18)[0]==62,'ELF_ARCH')
    phoff=struct.unpack_from('<Q',data,32)[0];ents,num=struct.unpack_from('<HH',data,54)
    loads=[];dynamic=None;interp=None
    for i in range(num):
        kind,flags,off,vaddr,_,filesz,_,_=struct.unpack_from('<IIQQQQQQ',data,phoff+i*ents)
        if kind==1:loads.append((vaddr,filesz,off))
        if kind==2:dynamic=(off,filesz)
        if kind==3:interp=data[off:off+filesz].rstrip(b'\0').decode()
    if not dynamic:return [],interp
    tags=[]
    for off in range(dynamic[0],sum(dynamic),16):
        tag,value=struct.unpack_from('<QQ',data,off)
        if tag==0:break
        tags.append((tag,value))
    straddr=next((v for t,v in tags if t==5),None)
    if straddr is None:return [],interp
    start=next((off+straddr-v for v,size,off in loads if v<=straddr<v+size),None);require(start is not None,'ELF_STRTAB')
    deps=[data[start+v:].split(b'\0',1)[0].decode() for t,v in tags if t==1]
    return deps,interp
def put(root,name,data,mode=0o644):
    portable(name);secret_scan(name,data);p=root/name;p.parent.mkdir(parents=True,exist_ok=True)
    if p.exists():require(p.read_bytes()==data,'IMAGE_COLLISION');return
    p.write_bytes(data);os.chmod(p,0o755 if mode&0o111 else 0o644)
def build(materials,deps,out,verified):
    if os.name=='nt':
        deps=Path('\\\\?\\'+str(deps.resolve()));out=Path('\\\\?\\'+str(out.resolve()))
    require(not out.exists(),'FRESH_OUTPUT_REQUIRED');out.mkdir(parents=True);scratch=out/'decode';scratch.mkdir()
    image=out/'runtime';image.mkdir();acquisition=json.loads((materials/'os-acquisition/os-acquisition-receipt.json').read_text())
    signature=json.loads(verified.read_text());require(signature['status']=='SIGNED_METADATA_AND_PACKAGES_VERIFIED','SIGNATURE_GATE')
    entries={};provenance=[]
    selected={'libc6','libgcc-s1','libstdc++6','zlib1g','libssl3t64','libicu74','powershell','git',
      'libpcre2-8-0','libcurl3t64-gnutls','libssh-4','librtmp1','libnettle8t64','libhogweed6t64','libgmp10',
      'libgnutls30t64','libunistring5','libtasn1-6','libp11-kit0','libidn2-0','libpsl5t64','libnghttp2-14',
      'libldap2','libsasl2-2','libsasl2-modules-db','libbrotli1','libgssapi-krb5-2','libkrb5support0',
      'libk5crypto3','libcom-err2','libkrb5-3','libkeyutils1','libuuid1','libunwind8','liblzma5','libzstd1','libselinux1'}
    for package in acquisition['packages']:
        if package['package'] not in selected:continue
        a=package['artifact'];file=materials/a['file'];require(sha(file.read_bytes())==a['sha256'],'DEB_SHA')
        require(signature['packages'][package['package']]['sha256']==a['sha256'] and signature['packages'][package['package']]['status']=='PASS','SIGNED_DEB_GATE')
        extracted=deb_entries(file,scratch)
        for name,value in extracted.items():
            if name in entries and entries[name][0] is not None and value[0] is not None:require(entries[name][0]==value[0],'DEB_COLLISION')
            if value[0] is not None or value[1] is not None:entries[name]=value
        provenance.append({'package':package['package'],'version':package['version'],'sha256':a['sha256'],'url':a['url']})
    require({p['package'] for p in provenance}==selected,'DEB_CLOSURE_MISSING')
    for name,extra in signature['extras'].items():
        if name!='dash':continue
        file=Path(extra['file']);require(sha(file.read_bytes())==extra['sha256'],'EXTRA_DEB_SHA');entries.update(deb_entries(file,scratch))
        provenance.append({'package':name,'version':extra['version'],'sha256':extra['sha256'],'url':extra['url']})
    reuse=json.loads((materials/'REUSE-RECEIPT.json').read_text());node=materials/'toolchain/node-v24.16.0-linux-x64.tar.xz'
    require(sha(node.read_bytes())==reuse['files']['toolchain/node-v24.16.0-linux-x64.tar.xz']['sha256'],'NODE_ARCHIVE_SHA')
    nodeEntries=tar_entries(node.read_bytes());nodeName='node-v24.16.0-linux-x64/bin/node';nodeBytes=resolve(nodeEntries,nodeName)[0]
    require(sha(nodeBytes)=='b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd','HISTORICALLY_APPROVED_NODE_BINARY_SHA')
    put(image,'usr/bin/node',nodeBytes,0o755)
    provenance.append({'package':'node','version':'24.16.0','sha256':sha(node.read_bytes()),
      'trustBasis':'Explicit historically approved VM116 staging binary SHA; no new upstream OpenPGP certification claimed'})
    for name in sorted(entries):
        if name=='opt/microsoft/powershell/7/libcoreclrtraceptprovider.so':continue
        if name.startswith('opt/microsoft/powershell/7/') or name in ['usr/bin/git','usr/lib/git-core/git'] or name.startswith('usr/share/git-core/templates/'):
            data,mode=resolve(entries,name);put(image,name,data,mode)
    put(image,'usr/bin/pwsh',b'#!/bin/sh\nexport DOTNET_EnableDiagnostics=0 DOTNET_EnableEventPipe=0\nexec /opt/microsoft/powershell/7/pwsh "$@"\n',0o755)
    dashName=next(n for n in ['usr/bin/dash','bin/dash'] if n in entries)
    put(image,'bin/sh',resolve(entries,dashName)[0],0o755)
    # Native dependency closure includes dynamically loaded .NET/OpenSSL/ICU libraries, not only DT_NEEDED.
    byname={PurePosixPath(name).name:name for name in entries if ('/lib/' in '/'+name or '/lib64/' in '/'+name) and (entries[name][0] is not None or entries[name][1] is not None)}
    queue=[p for p in image.rglob('*') if p.is_file()];observed={};seen=set()
    roots=[n for n in entries if re.search(r'/(libicu\w*\.so(?:\.\d+)*|libssl\.so\.3|libcrypto\.so\.3|libgssapi_krb5\.so\.2|libunwind\.so\.8|libnss_files\.so\.2)$',n)]
    for name in roots:
        data,mode=resolve(entries,name);put(image,name,data,mode);queue.append(image/name)
    while queue:
        file=queue.pop();rel=file.relative_to(image).as_posix()
        if rel in seen:continue
        seen.add(rel);needed,interp=elf_dependencies(file.read_bytes());observed[rel]={'needed':needed,'interpreter':interp}
        for lib in needed+([interp] if interp else []):
            target=lib.lstrip('/') if lib.startswith('/') else byname.get(lib)
            if target not in entries and lib.startswith('/') and 'usr/'+lib.lstrip('/') in entries:target='usr/'+lib.lstrip('/')
            if target not in entries:
                local=file.parent/lib
                if local.is_file():queue.append(local);continue
                raise ValueError('ELF_CLOSURE_MISSING:'+lib)
            data,mode=resolve(entries,target);put(image,target,data,mode);queue.append(image/target)
            if lib.startswith('/'):put(image,lib.lstrip('/'),data,mode);queue.append(image/lib.lstrip('/'))
            # Flatten both canonical and /lib lookup aliases to plain files; no symlinks in deployed image.
            if target.startswith('usr/lib/'):
                alias=target[4:];put(image,alias,data,mode);queue.append(image/alias)
    for d in ['candidate','proc','dev','tmp','evidence','etc','runtime/node_modules']: (image/d).mkdir(parents=True,exist_ok=True)
    put(image,'etc/hosts',b'127.0.0.1 localhost\n');put(image,'etc/nsswitch.conf',b'hosts: files\npasswd: files\ngroup: files\n')
    dependency=json.loads((deps/'DEPENDENCIES.json').read_text())
    for p in (deps/'runtime/node_modules').rglob('*'):
        require(not p.is_symlink(),'NPM_SYMLINK')
        if p.is_file():put(image,p.relative_to(deps).as_posix(),p.read_bytes(),p.stat().st_mode)
    for native in dependency['native']:
        data=(deps/native['file']).read_bytes();require(sha(data)==native['sha256'],'NPM_NATIVE_SHA')
        for name,value in tar_entries(data).items():
            if value[0] is not None:
                require(name.startswith('package/'),'NPM_TAR_PREFIX')
                for target in native['targets']:put(image,target+'/'+name[8:],value[0],value[2])
    # Verify the dependency closure of optional npm ELF code too; never silently rely on guest libraries.
    queue=[p for p in image.rglob('*') if p.is_file() and p.read_bytes()[:4]==b'\x7fELF'];seen=set()
    while queue:
        file=queue.pop();rel=file.relative_to(image).as_posix()
        if rel in seen:continue
        seen.add(rel);needed,interp=elf_dependencies(file.read_bytes());observed[rel]={'needed':needed,'interpreter':interp}
        for lib in needed+([interp] if interp else []):
            target=lib.lstrip('/') if lib.startswith('/') else byname.get(lib)
            if target not in entries and lib.startswith('/') and 'usr/'+lib.lstrip('/') in entries:target='usr/'+lib.lstrip('/')
            if target not in entries:
                local=file.parent/lib
                require(local.is_file(),'NPM_ELF_CLOSURE_MISSING:'+lib);queue.append(local);continue
            data,mode=resolve(entries,target);put(image,target,data,mode);queue.append(image/target)
            if target.startswith('usr/lib/'):put(image,target[4:],data,mode)
            if lib.startswith('/'):put(image,lib.lstrip('/'),data,mode)
    # PE is allowed only for signed PowerShell managed assemblies, never Windows native programs.
    for p in image.rglob('*'):
        if p.is_file():
            data=p.read_bytes();relative=p.relative_to(image).as_posix()
            require(not data.startswith(b'MZ') or (relative.startswith('opt/microsoft/powershell/7/') and relative.endswith('.dll')),'WINDOWS_BINARY')
            elf_dependencies(data)
    manifest={'schema':1,'node':'24.16.0','powershell':'7.6.6','git':'2.43.0','files':inventory(image),
      'publicInputs':provenance,'dependencies':dependency,'elfClosure':observed,'secrets':'Public packages and allowlisted static configs only; path/key-pattern checks; no host home/etc copied',
      'excludedOptionalPowerShellDiagnostics':['libcoreclrtraceptprovider.so; DOTNET_EnableDiagnostics=0; no incompatible lttng ABI substitution'],
      'linuxExecution':'NOT_RUN','authority':'NONE','productionDispatch':'CLOSED'}
    manifest['inventorySha256']=sha(canonical(manifest['files']).encode());(out/'CAPSULE-MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
    archive_tree(image,out/'capsule.tar');print(json.dumps({'capsuleSha256':sha((out/'capsule.tar').read_bytes()),'inventorySha256':manifest['inventorySha256'],'files':len(manifest['files'])}))
def archive_tree(root,target):
    with tarfile.open(target,'x',format=tarfile.USTAR_FORMAT) as t:
        for row in inventory(root):
            p=root/row['path'];data=p.read_bytes() if p.is_file() else b''
            info=tarfile.TarInfo(row['path']);info.uid=info.gid=info.mtime=0;info.mode=0o755 if p.is_dir() or data.startswith((b'\x7fELF',b'#!')) else 0o644
            if p.is_dir():info.type=tarfile.DIRTYPE;t.addfile(info)
            else:info.size=p.stat().st_size;t.addfile(info,io.BytesIO(p.read_bytes()))
def verify_archive(file,expected):
    with file.open('rb') as f:require(hashlib.file_digest(f,'sha256').hexdigest()==expected,'ARCHIVE_SHA')
    entries={};names=set();total=0
    with tarfile.open(file,'r:') as t:
        for member in t:
            name=portable(member.name.rstrip('/'));require(name not in entries and name.casefold() not in names,'CASE_ALIAS_OR_DUPLICATE');names.add(name.casefold())
            require(member.isfile() or member.isdir(),'LINK_OR_SPECIAL');require(not member.mode&0o6022 and member.uid==member.gid==0,'UNSAFE_MODE_OR_OWNER')
            require(member.size<=128*1024*1024 and len(entries)<50000,'ARCHIVE_LIMIT');total+=member.size;require(total<=2*1024**3,'ARCHIVE_TOTAL_LIMIT')
            for parent in PurePosixPath(name).parents:
                if str(parent)!='.':require(str(parent) in entries and entries[str(parent)]=='DIRECTORY','ARCHIVE_PARENT_MISSING_OR_FILE')
            if member.isfile():secret_scan(name,t.extractfile(member).read())
            entries[name]='DIRECTORY' if member.isdir() else 'FILE'
    return entries
if __name__=='__main__':
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='mode',required=True)
    b=sub.add_parser('build');b.add_argument('materials',type=Path);b.add_argument('dependencies',type=Path);b.add_argument('output',type=Path);b.add_argument('verifiedInputs',type=Path)
    v=sub.add_parser('verify');v.add_argument('archive',type=Path);v.add_argument('sha256')
    a=parser.parse_args()
    if a.mode=='build':build(a.materials,a.dependencies,a.output,a.verifiedInputs)
    else:print(json.dumps({'verifiedEntries':len(verify_archive(a.archive,a.sha256)),'linuxExecution':'NOT_RUN'}))
