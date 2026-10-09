"""Populate the dependency layout exclusively from lock-integrity-verified public npm archives."""
import hashlib
import json
import os
import struct
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import tar_entries,put,require,sha
def materialize(root):
    if os.name=='nt':root=Path('\\\\?\\'+str(root.resolve()))
    m=json.loads((root/'DEPENDENCIES.json').read_text());entries={};excluded=[]
    for id,p in m['publicArchives'].items():
        data=(root/p['file']).read_bytes();require(sha(data)==p['sha256'] and 'sha512-'+__import__('base64').b64encode(hashlib.sha512(data).digest()).decode()==p['integrity'],'PUBLIC_NPM_INTEGRITY')
        e=tar_entries(data)
        if 'package/package.json' not in e:
            candidates=[name for name in e if name.endswith('/package.json') and name.count('/')==1]
            require(len(candidates)==1,'PUBLIC_NPM_PREFIX:'+id);prefix=candidates[0].split('/')[0]+'/'
            require(all(name==prefix.rstrip('/') or name.startswith(prefix) for name in e),'PUBLIC_NPM_MULTIPLE_ROOTS')
            e={'package/'+name[len(prefix):]:value for name,value in e.items() if name.startswith(prefix)}
        meta=json.loads(e['package/package.json'][0]);require(meta['name']==p['name'] and meta['version']==p['version'],'PUBLIC_NPM_IDENTITY')
        require(set(meta.get('dependencies',{}))==set(p['dependencies']),'INSTALLED_GRAPH_PUBLIC_METADATA_MISMATCH')
        entries[id]=e
    for target,id in m['layout'].items():
        for name,(data,link,mode,hard) in entries[id].items():
            require(link is None,'NPM_ARCHIVE_ALIAS')
            if data is None:continue
            require(name.startswith('package/'),'NPM_PREFIX');relative=name[8:]
            if '/node_modules/' in '/'+relative:raise ValueError('UNDECLARED_VENDORED_DEPENDENCY')
            foreign=relative.endswith(('.exe','.dll','.dylib')) or ('/prebuilds/' in '/'+relative and '/prebuilds/linux-x64/' not in '/'+relative)
            if data[:4]==b'\x7fELF':foreign=foreign or data[4:6]!=b'\x02\x01' or struct.unpack_from('<H',data,18)[0]!=62
            if relative.endswith('.node') and data[:4]!=b'\x7fELF':foreign=True
            if foreign:excluded.append({'package':id,'path':relative});continue
            put(root,target+'/'+relative,data,mode)
    m['excludedForeign']=excluded;m['provenance']='All emitted npm bytes from committed-lock SHA512 verified public archives; no lifecycle execution'
    (root/'DEPENDENCIES.json').write_text(json.dumps(m,indent=2)+'\n');print(json.dumps({'verifiedPublicPackages':len(entries),'layoutPackages':len(m['layout'])}))
if __name__=='__main__':materialize(Path(sys.argv[1]))
