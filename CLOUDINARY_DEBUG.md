# Debug Cloudinary 401 Unauthorized Error

## Vấn đề
Khi upload ảnh lên Cloudinary, bạn gặp lỗi **401 Unauthorized**. Điều này xảy ra khi:
1. API Key/Secret sai
2. Signature không khớp với params gửi lên
3. Timestamp đã expired (> 1 giờ)

## Cách Debug

### Bước 1: Verify Credentials

Test credentials bằng cURL:

```bash
curl -X POST https://api.cloudinary.com/v1_1/kiukiu1304/image/upload \
  -F "file=@test.jpg" \
  -F "api_key=157282137355188" \
  -F "timestamp=$(date +%s)" \
  -F "signature=YOUR_SIGNATURE"
```

Nếu credentials sai → 401 ngay lập tức

### Bước 2: Kiểm tra Signature Generation

**Backend** (`cloudinary.service.ts`) đang sign các params:
```typescript
{
  timestamp: 1234567890,
  folder: 'slack/images',
  public_id: 'slack/images/abc123',
  quality: 'auto',
  fetch_format: 'auto'
}
```

**Frontend** (`use-file-upload.ts`) PHẢI gửi **CHÍNH XÁC** các params này:
```typescript
formData.append('timestamp', ...)
formData.append('folder', ...)
formData.append('public_id', ...)
formData.append('quality', 'auto')
formData.append('fetch_format', 'auto')
```

### Bước 3: Common Issues

#### Issue 1: Params không khớp

**Sai:**
```typescript
// Backend sign: { timestamp, folder, public_id }
// Frontend gửi: { timestamp, folder, public_id, quality, fetch_format }
// → 401 vì frontend gửi thêm params chưa được signed
```

**Đúng:**
```typescript
// Backend sign: { timestamp, folder, public_id, quality, fetch_format }
// Frontend gửi: { timestamp, folder, public_id, quality, fetch_format }
// → OK ✅
```

#### Issue 2: Timestamp expired

Cloudinary signature có TTL ~1 giờ. Nếu client delay upload → 401

**Fix:** Upload ngay sau khi nhận signature

#### Issue 3: API Secret sai

Verify trong Cloudinary Dashboard:
1. Vào https://console.cloudinary.com/
2. Settings → Access Keys
3. Copy **API Secret** chính xác (case-sensitive)

### Bước 4: Test với Cloudinary Console

1. Vào https://console.cloudinary.com/console/media_library/upload
2. Upload thử 1 file manually
3. Nếu thành công → credentials OK, vấn đề ở signature logic
4. Nếu thất bại → check account status (free tier có giới hạn)

## Fix Code

### Option A: Đơn giản hóa - Không dùng signature (unsigned upload)

**⚠️ Chỉ dùng cho development!**

Backend:
```typescript
// Trả về upload preset thay vì signature
return {
  cloudName: this.cloudName,
  uploadPreset: 'your_unsigned_preset', // Tạo trong Cloudinary Dashboard
  folder: 'slack/images',
}
```

Frontend:
```typescript
formData.append('upload_preset', signatureData.uploadPreset)
formData.append('folder', signatureData.folder)
// Không cần signature, timestamp, api_key
```

### Option B: Debug signature params

Thêm logging để verify params:

Backend (`cloudinary.service.ts`):
```typescript
const uploadParams = { timestamp, folder, public_id: publicId, quality: 'auto', fetch_format: 'auto' }
console.log('Params to sign:', uploadParams)
const signature = cloudinary.utils.api_sign_request(uploadParams, apiSecret)
console.log('Generated signature:', signature)
```

Frontend (`use-file-upload.ts`):
```typescript
console.log('Sending to Cloudinary:', {
  timestamp: signatureData.timestamp,
  folder: signatureData.folder,
  public_id: signatureData.publicId,
  signature: signatureData.signature,
  api_key: signatureData.apiKey,
})
```

Compare logs để đảm bảo params khớp 100%!

## Recommended Solution

**Đơn giản hóa signature params** - chỉ sign những gì cần thiết:

Backend:
```typescript
const uploadParams: Record<string, unknown> = {
  timestamp,
  folder,
  public_id: publicId,
  // Bỏ quality và fetch_format khỏi signature
}
const signature = cloudinary.utils.api_sign_request(uploadParams, apiSecret)
```

Frontend:
```typescript
formData.append('file', file)
formData.append('signature', signatureData.signature)
formData.append('timestamp', signatureData.timestamp.toString())
formData.append('api_key', signatureData.apiKey)
formData.append('folder', signatureData.folder)
formData.append('public_id', signatureData.publicId)
// Không gửi quality và fetch_format (hoặc gửi nhưng không sign)
```

---

**Bạn muốn tôi implement solution nào?**
1. Debug với logging (để tìm root cause)
2. Đơn giản hóa params (remove quality/fetch_format khỏi signature)
3. Dùng unsigned upload preset (cho dev)
