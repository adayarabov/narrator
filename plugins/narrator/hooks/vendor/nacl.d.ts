declare const nacl: {
  randomBytes(length: number): Uint8Array
  secretbox: {
    (message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null
    keyLength: number
    nonceLength: number
  }
}
export default nacl
