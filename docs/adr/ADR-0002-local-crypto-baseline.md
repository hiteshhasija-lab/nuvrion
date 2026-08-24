# ADR-0002: Local cryptography baseline

Status: provisional

New passwords use Argon2id with a 19 MiB memory cost, two passes, one lane, and a 256-bit output. Existing scrypt hashes remain verifiable and are transparently upgraded after successful authentication. Production credentials use an explicit versioned key ring (`NUVRION_ENCRYPTION_KEYS`) and active key identifier (`NUVRION_ACTIVE_ENCRYPTION_KEY_ID`). Every ciphertext records its key identifier, uses authenticated context, and remains decryptable while its retired key is retained. Deployments must inject this key ring from their KMS/HSM-backed secret manager; key material must not be committed or stored in ordinary configuration. Plaintext credentials are never returned by connection APIs or persisted in task/audit payloads.
