#!/bin/bash
set -euo pipefail
printf '%s\n' 'RC02_STAGE1_LXC_WRAPPER_RETIRED=STOP; KVM_PROOF_COMPLETE; PRODUCTION_DISABLED' >&2
exit 64
