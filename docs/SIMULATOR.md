# Local approval simulator

Run `npm run simulate`, paste a v1 payment JSON object, then submit an empty line. Type `APPROVE` to simulate the physical button.

The simulator generates a fresh ephemeral Ed25519 keypair per run. It displays the exact encoded message and signature, but its public key is not registered in the NEAR contract. It cannot authorize an on-chain payment.

Use `protocol/v1-vector.json` as the canonical byte-encoding fixture. Never treat the simulator's ephemeral key as a device identity.
