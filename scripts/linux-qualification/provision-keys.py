"""Fresh campaign transport keys, only after separate Human approval. Never Human approval/signing keys.
Write to a new private custody directory; print public fingerprints only. No existing key is read/copied.
"""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

def provision(directory,openssl='/usr/bin/openssl'):
    if directory.exists():raise ValueError('KEY_CUSTODY_DIRECTORY_EXISTS')
    directory.mkdir(mode=0o700)
    def cmd(args):
        r=subprocess.run([openssl,*args],capture_output=True,timeout=60)
        if r.returncode:raise ValueError('CAMPAIGN_KEY_GENERATION_FAILED')
    for role in ['client','broker']:
        cmd(['genpkey','-algorithm','ED25519','-out',str(directory/(role+'-private.pem'))])
        cmd(['pkey','-in',str(directory/(role+'-private.pem')),'-pubout','-out',str(directory/(role+'-public.pem'))])
    cmd(['req','-x509','-newkey','rsa:3072','-nodes','-days','2','-subj','/CN=ai-linux-qualification-117',
      '-addext','subjectAltName=IP:192.168.0.54','-addext','basicConstraints=critical,CA:TRUE','-keyout',str(directory/'tls-private.pem'),'-out',str(directory/'tls-cert.pem')])
    for p in directory.iterdir():os.chmod(p,0o600)
    cert=(directory/'tls-cert.pem').read_bytes();(directory/'tls-cert.sha256').write_text(hashlib.sha256(cert).hexdigest()+'\n');os.chmod(directory/'tls-cert.sha256',0o600)
    return directory
def role_input(directory,role):
    names=['client-public.pem','broker-private.pem','broker-public.pem','tls-private.pem','tls-cert.pem'] if role=='executor' else ['client-private.pem','broker-public.pem','tls-cert.pem','tls-cert.sha256']
    return {name:(directory/name).read_text() for name in names}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);p.add_argument('--human-approval-reference',required=True);a=p.parse_args()
    if os.name!='posix' or not a.human_approval_reference.strip():raise ValueError('LINUX_PRIVATE_CUSTODY_AND_ACTUAL_APPROVAL_REQUIRED')
    provision(a.directory);print(json.dumps({'result':'GENERATED_PRIVATE_CUSTODY','publicTlsSha256':(a.directory/'tls-cert.sha256').read_text().strip()}))
