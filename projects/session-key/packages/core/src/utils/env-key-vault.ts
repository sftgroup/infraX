import { encrypt, decrypt, loadEncryptionKey } from './crypto.js';
import type { IKeyVault } from '../interfaces/IKeyVault.js';

/**
 * AX-12/SK-4: 默认密钥托管实现——ENCRYPTION_KEY（32 字节 hex）+ AES-256-GCM。
 * 这是向后兼容的现状路径；集成方可注入 IKeyVault 换成 KMS/外部密钥服务。
 */
export class EnvKeyVault implements IKeyVault {
  async encrypt(plaintext: string): Promise<string> {
    return encrypt(plaintext, loadEncryptionKey());
  }

  async decrypt(ciphertext: string): Promise<string> {
    return decrypt(ciphertext, loadEncryptionKey());
  }
}
