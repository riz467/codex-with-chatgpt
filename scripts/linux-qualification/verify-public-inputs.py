"""Read-only verification of reused metadata with pinned public signing keys; no gpg-agent needed."""
import argparse
import gzip
import hashlib
import json
import lzma
import subprocess
import urllib.request
from pathlib import Path

def sha(data):return hashlib.sha256(data).hexdigest()
def gpg_path(p,gpg):
    v=p.resolve().as_posix()
    return '/'+v[0].lower()+v[2:] if '/Git/' in gpg and v[1:2]==':' else v
def signed_index_match(plaintext,digest,size,path):
    section=False;rows=[]
    for line in plaintext.splitlines():
        if line=='SHA256:':section=True;continue
        if section and line and not line[0].isspace():section=False
        if section:
            row=line.split()
            if len(row)==3 and row[2]==path:rows.append(row)
    return rows==[[digest,str(size),path]]
def verify(root,gpg,output):
    result={'metadata':{},'packages':{},'installed':False};meta=root/'os-acquisition/metadata'
    allowed={'F6ECB3762474EDA9D21B7022871920D1991BC93C','790BC7277767219C42C86F933B4FE6ACC0B21F32'}
    home=root/'isolated-public-gpg-v3'
    indexes={}
    for repo in ['noble','noble-updates','noble-security','microsoft-noble']:
        signed=meta/(repo+'-InRelease');index=meta/(repo+('-Packages.gz' if repo.startswith('microsoft') else '-Packages.xz'))
        armored=signed.read_text();end='-----END PGP SIGNATURE-----'
        if armored.count(end)!=1 or armored.split(end,1)[1].strip():raise ValueError('UNSIGNED_INRELEASE_TRAILER')
        r=subprocess.run([gpg,'--batch','--no-options','--no-autostart','--homedir',gpg_path(home,gpg),'--status-fd','2',
            '--decrypt',gpg_path(signed,gpg)],capture_output=True,text=True,timeout=30)
        rows=[x.split() for x in r.stderr.splitlines() if x.startswith('[GNUPG:] VALIDSIG ')]
        pins={'BC528686B50D79E339D3721CEB3E94ADBE1229CF'} if repo.startswith('microsoft') else allowed
        ok=r.returncode==0 and bool(rows) and all(x[2] in pins or x[-1] in pins for x in rows)
        checksum=sha(index.read_bytes());match=signed_index_match(r.stdout,checksum,index.stat().st_size,'main/binary-amd64/'+index.name.split('-')[-1])
        if not ok or not match:raise ValueError('PUBLIC_METADATA_SIGNATURE_OR_INDEX:'+repo)
        result['metadata'][repo]={'status':'PASS','primarySigners':[x[-1] for x in rows],'indexSha256':checksum}
        data=(gzip.decompress if repo.startswith('microsoft') else lzma.decompress)(index.read_bytes()).decode()
        indexes[repo]=data
    acquired=json.loads((root/'os-acquisition/os-acquisition-receipt.json').read_text())
    for p in acquired['packages']:
        a=p['artifact'];records=[dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' ')) for text in indexes.values() for block in text.split('\n\n')]
        matches=[r for r in records if r.get('Package')==p['package'] and r.get('Version')==p['version'] and r.get('SHA256')==a['sha256']]
        if not matches or sha((root/a['file']).read_bytes())!=a['sha256']:raise ValueError('SIGNED_PACKAGE_CHAIN:'+p['package'])
        result['packages'][p['package']]={'version':p['version'],'sha256':a['sha256'],'status':'PASS'}
    # Small fixed POSIX shell for pwsh wrapper; acquire public bytes, never install/execute.
    dash=[]
    for repo in ['noble-updates','noble-security','noble']:
        for block in indexes[repo].split('\n\n'):
            r=dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
            if r.get('Package')=='dash' and r.get('Architecture')=='amd64':dash.append(r)
        if dash:break
    extras={}
    for name in ['dash','liblttng-ust1t64','liblttng-ust-common1t64','liblttng-ust-ctl5t64','libnuma1','liburcu8t64']:
        matches=[]
        for repo in ['noble-updates','noble-security','noble']:
            for block in indexes[repo].split('\n\n'):
                p=dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
                if p.get('Package')==name and p.get('Architecture')=='amd64':matches.append(p)
            if matches:break
        p=matches[0];url='https://archive.ubuntu.com/ubuntu/'+p['Filename'];file=output.parent/(name+'.deb')
        data=urllib.request.urlopen(url,timeout=60).read()
        if sha(data)!=p['SHA256']:raise ValueError('EXTRA_DEB_SHA')
        if file.exists() and file.read_bytes()!=data:raise ValueError('OUTPUT_CONFLICT')
        file.write_bytes(data);extras[name]={'version':p['Version'],'sha256':p['SHA256'],'url':url,'file':str(file),'status':'PASS'}
    result['dash']=extras['dash'];result['extras']=extras
    result['status']='SIGNED_METADATA_AND_PACKAGES_VERIFIED';result['cloudImage']='NOT_USED';output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'status':result['status'],'packages':len(result['packages']),'extras':len(extras)}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('materials',type=Path);p.add_argument('gpg');p.add_argument('output',type=Path);a=p.parse_args();verify(a.materials,a.gpg,a.output)
