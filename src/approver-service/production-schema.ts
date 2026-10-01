import type { DatabaseSync } from 'node:sqlite';

export function installProductionSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE trusted_presentations (
    approval_request_id TEXT PRIMARY KEY REFERENCES typed_action_approval_requests(approval_request_id),
    presentation_id TEXT NOT NULL UNIQUE, presentation_hash TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CURRENT','STALE','SUPERSEDED')));
    CREATE TRIGGER presentation_body_immutable BEFORE UPDATE OF approval_request_id,presentation_id,presentation_hash,body
    ON trusted_presentations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PRESENTATION'); END;
    CREATE TRIGGER presentation_terminal BEFORE UPDATE OF state ON trusted_presentations
    WHEN OLD.state != 'CURRENT' BEGIN SELECT RAISE(ABORT,'TERMINAL_PRESENTATION'); END;
    CREATE TRIGGER credential_identity_immutable BEFORE UPDATE OF credential_id,public_key,transports,created_at
    ON webauthn_credentials BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CREDENTIAL'); END;
    CREATE TRIGGER credential_monotonic BEFORE UPDATE ON webauthn_credentials
    WHEN NEW.sign_count < OLD.sign_count OR NEW.authentication_revision < OLD.authentication_revision OR NEW.enabled > OLD.enabled
    BEGIN SELECT RAISE(ABORT,'CREDENTIAL_ROLLBACK'); END;
    CREATE TRIGGER typed_state_terminal BEFORE UPDATE OF state ON typed_action_approval_requests
    WHEN OLD.state = 'APPROVED' BEGIN SELECT RAISE(ABORT,'TERMINAL_APPROVAL'); END;
    CREATE TRIGGER legacy_request_disabled BEFORE INSERT ON approval_requests BEGIN SELECT RAISE(ABORT,'LEGACY_DISABLED'); END;
    CREATE TRIGGER legacy_evidence_disabled BEFORE INSERT ON approval_evidence BEGIN SELECT RAISE(ABORT,'LEGACY_DISABLED'); END;
    PRAGMA user_version=7001;`);
  for (const table of ['trusted_presentations', 'typed_action_approval_requests', 'typed_action_approval_evidence', 'webauthn_credentials', 'consumed_jti', 'audit']) {
    db.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'NO_DELETE'); END;`);
  }
  for (const table of ['typed_action_approval_evidence', 'consumed_jti', 'audit']) {
    db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE'); END;`);
  }
}
export function schemaIdentity(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
}
