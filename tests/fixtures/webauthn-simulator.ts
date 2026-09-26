import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const b64 = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString("base64url");
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([major << 5 | n]) :
    n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (typeof value === "number") return head(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value);
  if (typeof value === "string") { const v = Buffer.from(value); return Buffer.concat([head(3, v.length), v]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value && typeof value === "object") return Buffer.concat([head(5, Object.keys(value).length),
    ...Object.entries(value).flatMap(([k, v]) => [cbor(/^-?\d+$/.test(k) ? Number(k) : k), cbor(v)])]);
  throw new Error("INVALID_FIXTURE");
}
const client = (type: string, challenge: string, origin: string) => b64(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
const rpHash = (rp: string) => createHash("sha256").update(rp).digest();

export function authenticator() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const publicKey = cbor({ 1: 2, 3: -7, "-1": 1, "-2": Buffer.from(jwk.x!, "base64url"), "-3": Buffer.from(jwk.y!, "base64url") });
  return {
    id: b64(id),
    registration(challenge: string, origin: string, rp: string, uv = true) {
      const auth = Buffer.concat([rpHash(rp), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([0, id.length]), id, publicKey]);
      return { id: b64(id), rawId: b64(id), type: "public-key", response: {
        clientDataJSON: client("webauthn.create", challenge, origin), attestationObject: b64(cbor({ fmt: "none", attStmt: {}, authData: auth })) },
        clientExtensionResults: {} };
    },
    assertion(challenge: string, origin: string, rp: string, counter = 1, uv = true) {
      const count = Buffer.alloc(4); count.writeUInt32BE(counter);
      const auth = Buffer.concat([rpHash(rp), Buffer.from([uv ? 0x05 : 0x01]), count]);
      const data = client("webauthn.get", challenge, origin);
      return { id: b64(id), rawId: b64(id), type: "public-key", response: { clientDataJSON: data, authenticatorData: b64(auth),
        signature: b64(sign("sha256", Buffer.concat([auth, createHash("sha256").update(Buffer.from(data, "base64url")).digest()]), pair.privateKey)),
        userHandle: null }, clientExtensionResults: {} };
    },
  };
}
