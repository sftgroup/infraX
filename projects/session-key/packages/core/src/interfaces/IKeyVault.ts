/**
 * AX-12/SK-4: 可选的密钥托管接缝（KMS / 外部密钥服务）。
 *
 * 默认路径是 `EnvKeyVault`（ENCRYPTION_KEY + AES-256-GCM）。集成方可注入
 * 自己的实现（AWS/GCP KMS 代理、HashiCorp Vault transit、自建密钥服务等），
 * 让会话私钥**不落明文 env**，由外部密钥管理系统托管。
 *
 * 注意：外部托管通常是网络调用（异步），因此这里一律 Promise。
 */
export interface IKeyVault {
  /** 加密明文并返回密文（服务端存储 `sessionKeyEnc` 用）。 */
  encrypt(plaintext: string): Promise<string>;
  /** 解密密文返回明文（execute 代签时用）。 */
  decrypt(ciphertext: string): Promise<string>;
}
