# Google Sheets ↔ Bitrix24 Lead Sync

Tự động đồng bộ danh sách khách hàng tiềm năng (leads) giữa Google Sheets và Bitrix24 CRM:
tạo lead mới, cập nhật lead đã có, chống trùng theo Email/SĐT, ghi trạng thái đồng bộ ngược lại vào Sheet.

- **Stack:** Node.js 20 (JavaScript, ES modules), chỉ 2 dependency: `@googleapis/sheets`, `node-cron`
- **Chạy:** theo lịch (cron), thủ công qua CLI, HTTP endpoint hoặc nút bấm trên admin panel, có Docker
- **Test:** `node:test`, 80+ test, coverage ~99%

**Tính năng nâng cao (điểm cộng):**
- **Đồng bộ hai chiều:** thay đổi trạng thái / người phụ trách trên Bitrix24 được kéo về Sheet, có xử lý xung đột theo mức ưu tiên ([mục 5.1](#51-đồng-bộ-hai-chiều--xử-lý-xung-đột))
- **Real-time:** nhận webhook `ONCRMLEADUPDATE` từ Bitrix24 để cập nhật Sheet ngay ([mục 5.2](#52-real-time-webhook-từ-bitrix24))
- **Xử lý dữ liệu nâng cao:** enum, trường nhiều giá trị, chuẩn hoá SĐT/email/ngày/số, luật validate ([mục 3.2](#32-mapping-configmappingjson))
- **Admin panel:** giao diện web để xem trạng thái, sửa mapping, xem log, bấm đồng bộ ([mục 5.3](#53-admin-panel))

---

## 1. Kiến trúc

```
                 ┌──────────────┐◀── cron (SYNC_CRON)
  CLI: sync ───▶ │              │◀── POST /sync, nút "Đồng bộ ngay" (admin panel)
                 │  SyncRunner  │◀── POST /webhooks/bitrix (debounce, real-time)
                 └──────┬───────┘    khoá: chỉ 1 phiên chạy cùng lúc
                        ▼
                 ┌──────────────┐
                 │   runSync    │  sync.js – điều phối toàn bộ luồng
                 └──┬───────┬───┘
       mapper.js    │       │
  (map, validate,   ▼       ▼
   normalize, hash)
          ┌───────────┐   ┌────────────┐
          │ sheets.js │   │ bitrix.js  │  retry + backoff, throttle, batch 50 lệnh
          └─────┬─────┘   └─────┬──────┘
                ▼               ▼
        Google Sheets API   Bitrix24 REST API (webhook)
```

| File | Trách nhiệm |
|---|---|
| [src/cli.js](src/cli.js) | Entry point: `sync` (chạy 1 lần) / `serve` (HTTP + cron) |
| [src/config.js](src/config.js) | Đọc biến môi trường + `mapping.json`, validate cấu hình |
| [src/sync.js](src/sync.js) | Luồng đồng bộ + `SyncRunner` (chống chạy chồng, lưu kết quả lần cuối) |
| [src/mapper.js](src/mapper.js) | Map cột → field, chuẩn hoá SĐT/email/số/enum, validate, tính hash |
| [src/sheets.js](src/sheets.js) | Google Sheets API v4: đọc sheet, ghi header, batch update ô |
| [src/bitrix.js](src/bitrix.js) | Bitrix24 REST client: `call`, `batch`, retry, throttle |
| [src/retry.js](src/retry.js) | Exponential backoff + jitter, giới hạn số lần thử |
| [src/server.js](src/server.js) | HTTP API, API cho admin panel, endpoint nhận webhook Bitrix24 |
| [src/admin.html](src/admin.html) | Admin panel (một file HTML + JS thuần, không cần build) |
| [src/logger.js](src/logger.js) | Log ra console + file |

### Luồng một lần đồng bộ

1. **Đọc** toàn bộ worksheet (1 request). Nếu thiếu các cột trạng thái thì tự thêm vào header.
2. **Map + validate** từng hàng theo `mapping.json`, tính `hash` của dữ liệu đã chuẩn hoá. Hàng trống bị bỏ qua.
3. **Phân loại** từng hàng:
   - Dữ liệu sai → ghi `Lỗi` + lý do, không gửi lên Bitrix.
   - Có `Lead ID` và hash không đổi và đang `Đã đồng bộ` → Sheet **không đổi**.
   - Có `Lead ID` nhưng dữ liệu đổi (hoặc lần trước lỗi) → Sheet **đã đổi**, cần cập nhật.
   - Chưa có `Lead ID` → **tạo mới** (sau khi kiểm tra trùng).
4. **Chống trùng:** với mỗi hàng mới, tìm lead có cùng Email rồi đến SĐT (`crm.lead.list`, gửi qua `batch`).
   Nếu đã có lead thì chuyển sang cập nhật lead đó. Hai hàng mới trong cùng sheet trùng Email/SĐT thì chỉ hàng đầu
   được tạo, hàng sau để `Chờ xử lý` và sẽ được nhận diện là trùng ở lần chạy sau.
5. **Đọc các lead đã liên kết** (`crm.lead.get`, qua `batch`). Chế độ một chiều chỉ đọc các hàng Sheet đã đổi,
   chế độ hai chiều đọc tất cả để biết lead nào bị sửa trên Bitrix (`DATE_MODIFY` > `Thời gian đồng bộ cuối`).
   Bước này còn lấy ID của các entry Email/SĐT, nên email/SĐT đổi giá trị sẽ **thay thế** entry cũ thay vì thêm entry trùng.
   Sau đó quyết định đẩy lên, kéo về hay xử lý xung đột ([mục 5.1](#51-đồng-bộ-hai-chiều--xử-lý-xung-đột)).
6. **Ghi Bitrix:** `crm.lead.add` / `crm.lead.update` qua `batch` (50 lệnh/request).
7. **Ghi ngược Sheet** trong 1 request `values.batchUpdate`: trạng thái, Lead ID, thời gian, lỗi, hash.

Nhờ vậy 150 hàng mới chỉ tốn khoảng 1 request đọc Sheet, 6 + 3 request batch tới Bitrix và 1 request ghi Sheet.
Ở chế độ hai chiều, mỗi 50 hàng đã liên kết tốn thêm 1 request `crm.lead.get` để kiểm tra thay đổi.

### Reliability

- **Retry + backoff:** lỗi mạng, HTTP 429/5xx, `QUERY_LIMIT_EXCEEDED` được thử lại tối đa `RETRY_MAX` lần, chờ
  `base × 2^n + jitter`. Lỗi 4xx (sai dữ liệu, sai quyền) báo lỗi ngay, không retry.
- **Throttle Bitrix:** các request cách nhau tối thiểu `BITRIX_MIN_INTERVAL_MS` (mặc định 500ms ≈ 2 req/s).
- **Lỗi từng bản ghi không làm dừng cả lượt:** lệnh nào lỗi thì hàng đó bị đánh dấu `Lỗi`, các hàng khác vẫn chạy.
  Hàng lỗi sẽ được thử lại ở lần chạy sau.
- **Idempotent:** chạy lại nhiều lần không tạo trùng, vì đã có Lead ID + hash để nhận ra hàng không đổi. Nếu bước ghi
  ngược Sheet thất bại sau khi lead đã được tạo, lần sau bước kiểm tra trùng Email/SĐT sẽ tìm ra lead đó và cập nhật
  thay vì tạo thêm.
- **Không chạy chồng:** khi cron và trigger thủ công trùng thời điểm, trigger đến sau bị bỏ qua (HTTP trả 409).

---

## 2. Cài đặt

Yêu cầu: Node.js ≥ 20.12 (hoặc Docker).

```bash
git clone <repo> && cd ggsheet-bitrix24-intergrated
npm install
cp .env.example .env     # rồi điền giá trị
```

### 2.1 Google API credentials

**Cách 1 — Service Account (khuyến nghị cho server):**
1. Vào [Google Cloud Console](https://console.cloud.google.com/) → tạo (hoặc chọn) project.
2. *APIs & Services → Library* → bật **Google Sheets API**.
3. *APIs & Services → Credentials → Create credentials → Service account* → tạo xong vào tab *Keys → Add key → JSON*.
4. Lưu file thành `credentials/service-account.json` (thư mục này đã nằm trong `.gitignore`).
5. Mở Google Sheet → **Share** cho email của service account (`...@...iam.gserviceaccount.com`) với quyền **Editor**.
6. Trong `.env`: `GOOGLE_SERVICE_ACCOUNT_FILE=credentials/service-account.json`.

**Cách 2 — OAuth 2.0 (đăng nhập bằng tài khoản người dùng):**
1. *Credentials → Create credentials → OAuth client ID* (loại *Web application*), thêm redirect URI
   `https://developers.google.com/oauthplayground`.
2. Mở [OAuth Playground](https://developers.google.com/oauthplayground) → ⚙️ → *Use your own OAuth credentials* →
   nhập client ID/secret → chọn scope `https://www.googleapis.com/auth/spreadsheets` → *Authorize* →
   *Exchange authorization code for tokens* → copy **refresh token**.
3. Trong `.env`: để trống `GOOGLE_SERVICE_ACCOUNT_FILE`, điền `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REFRESH_TOKEN`.

**Sheet ID:** lấy từ URL `https://docs.google.com/spreadsheets/d/<GOOGLE_SHEET_ID>/edit`.
`GOOGLE_SHEET_NAME` là tên tab (mặc định `Leads`).

### 2.2 Bitrix24 webhook

1. Bitrix24 → **Developer resources** (Ứng dụng → Tài nguyên cho nhà phát triển) → **Other → Inbound webhook**.
2. Tích quyền **CRM (crm)** → Save.
3. Copy URL dạng `https://<portal>.bitrix24.vn/rest/<user_id>/<token>/` → điền vào `BITRIX_WEBHOOK_URL`.

> URL webhook chứa token: không commit, không chia sẻ. Ứng dụng không bao giờ ghi URL này vào log.

### 2.3 Chuẩn bị Google Sheet

- Import [samples/leads-sample.csv](samples/leads-sample.csv) vào Google Sheets (*File → Import → Upload*),
  đổi tên tab thành `Leads`. File mẫu có sẵn vài hàng lỗi (email sai, thiếu tên, trạng thái sai, trùng email)
  để demo phần xử lý lỗi.
- Hàng 1 là tiêu đề cột, phải khớp với `column` trong `mapping.json`.
- Các cột trạng thái (`Trạng thái đồng bộ`, `Lead ID Bitrix24`, `Thời gian đồng bộ cuối`, `Thông báo lỗi`,
  `Sync Hash`) sẽ được **tự thêm** nếu chưa có. Nên **ẩn cột `Sync Hash`** (và `Lead ID Bitrix24` nếu muốn):
  chuột phải vào cột → *Hide column*. Không sửa tay hai cột này.
- Dữ liệu test hiệu năng: `node scripts/generate-csv.js 150 > leads-150.csv`.

---

## 3. Cấu hình

### 3.1 Biến môi trường (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `GOOGLE_SHEET_ID` | *(bắt buộc)* | ID của spreadsheet |
| `GOOGLE_SHEET_NAME` | `Leads` | Tên worksheet (tab) |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | | Đường dẫn file JSON của service account |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` | | Dùng OAuth khi không có service account |
| `BITRIX_WEBHOOK_URL` | *(bắt buộc)* | Inbound webhook URL |
| `BITRIX_MIN_INTERVAL_MS` | `500` | Khoảng cách tối thiểu giữa 2 request Bitrix |
| `BITRIX_OUTBOUND_TOKEN` | | `application_token` của Outbound webhook (real-time). Để trống: tắt endpoint webhook |
| `WEBHOOK_DEBOUNCE_MS` | `3000` | Gộp các sự kiện webhook đến dồn dập thành 1 lần đồng bộ |
| `MAPPING_FILE` | `config/mapping.json` | File mapping + chiều đồng bộ (admin panel ghi vào file này) |
| `SYNC_CRON` | `*/15 * * * *` | Lịch chạy: `*/15 * * * *` mỗi 15 phút, `0 * * * *` mỗi giờ, `0 8 * * *` 8h sáng hằng ngày |
| `SYNC_ON_START` | `true` | Đồng bộ ngay 1 lần khi `npm start`. Cron chỉ chạy ở mốc kế tiếp (với `*/15` là :00, :15, :30, :45), không tính từ lúc khởi động |
| `TZ` | `Asia/Ho_Chi_Minh` | Múi giờ của lịch cron |
| `RETRY_MAX` / `RETRY_BASE_DELAY_MS` | `3` / `1000` | Số lần retry và thời gian chờ cơ sở |
| `PORT` | `3000` | Cổng HTTP |
| `ADMIN_TOKEN` | | Bảo vệ admin panel và API: header `Authorization: Bearer <token>`. **Nên đặt khi public server** |
| `LOG_FILE` | `logs/sync.log` | File log (để trống: chỉ log console) |

### 3.2 Mapping ([config/mapping.json](config/mapping.json))

```jsonc
{
  "fields": [
    { "column": "Tên khách hàng", "field": "NAME", "required": true },
    { "column": "Email", "field": "EMAIL", "type": "email" },
    { "column": "Số điện thoại", "field": "PHONE", "type": "phone" },
    { "column": "Ngân sách dự kiến", "field": "OPPORTUNITY", "type": "number" },
    { "column": "Trạng thái", "field": "STATUS_ID", "type": "enum",
      "values": { "Mới": "NEW", "Đang xử lý": "IN_PROCESS" } },
    { "column": "Người phụ trách", "field": "ASSIGNED_BY_ID", "type": "enum", "twoWay": true,
      "values": { "Admin": 1, "Lan": 7 } },                      // twoWay: kéo thay đổi từ Bitrix về Sheet
    { "column": "Mã KH nội bộ", "field": "UF_CRM_1700000000" },  // custom field: dùng mã UF_CRM_...
    { "column": "Sở thích", "field": "UF_CRM_1700000001", "type": "enum", "multiple": true,
      "values": { "Website": 45, "App": 46 } },                  // ô "Website, App" -> [45, 46]
    { "column": "Ngày hẹn", "field": "UF_CRM_1700000002", "type": "date" },
    { "column": "Mã số thuế", "field": "UF_CRM_1700000003", "pattern": "^\\d{10}(-\\d{3})?$",
      "patternMessage": "MST phải gồm 10 chữ số" },
    { "column": "Ghi chú", "field": "COMMENTS", "maxLength": 2000 }
  ],
  "sync": { "direction": "two-way", "conflictPriority": "bitrix" },  // hoặc "one-way" / "sheet"
  "defaults": { "SOURCE_ID": "OTHER" },         // giá trị cố định gửi kèm mọi lead
  "statusColumns": { "status": "...", "leadId": "...", "syncedAt": "...", "error": "...", "hash": "..." }
}
```

Có thể sửa tất cả các mục này trên admin panel ([mục 5.3](#53-admin-panel)) thay vì sửa file.

| `type` | Xử lý |
|---|---|
| `string` *(mặc định)* | Giữ nguyên (đã trim) |
| `email` | Chuyển chữ thường, kiểm tra định dạng |
| `phone` | Chuẩn hoá về E.164: `0912 345 678` → `+84912345678` |
| `number` | Bỏ ký tự không phải số: `50.000.000 đ` → `50000000` (số nguyên, ví dụ VND) |
| `date` | `19/10/2026`, `19-10-2026`, `2026-10-19` → `2026-10-19`; báo lỗi ngày không tồn tại (`31/02/2026`) |
| `enum` | Tra bảng `values` (không phân biệt hoa thường), giá trị lạ → lỗi kèm danh sách hợp lệ |

| Tuỳ chọn | Ý nghĩa |
|---|---|
| `required: true` | Thiếu giá trị thì hàng bị đánh dấu lỗi, thiếu cột thì cả lượt dừng với thông báo rõ ràng |
| `multiple: true` | Ô chứa nhiều giá trị cách nhau bởi `,` `;` hoặc xuống dòng → gửi mảng (cho trường nhiều giá trị của Bitrix) |
| `pattern` / `patternMessage` | Regex mà giá trị phải khớp, kèm thông báo lỗi tuỳ chỉnh |
| `maxLength` | Độ dài tối đa |
| `twoWay: true` | Kéo thay đổi của trường này từ Bitrix24 về Sheet (khi `sync.direction = "two-way"`) |

- Mỗi hàng cần **ít nhất Email hoặc SĐT**, vì đây là căn cứ để chống trùng.
- Nếu không map `TITLE`, tiêu đề lead sẽ là `Tên - Công ty`.
- Mã custom field: Bitrix24 → CRM → Settings → Custom fields, hoặc gọi `crm.lead.fields`.
- `Người phụ trách` map tên → user ID của Bitrix (xem ID trong URL trang profile `/company/personal/user/<ID>/`).

---

## 4. Chạy ứng dụng

```bash
npm run sync        # đồng bộ 1 lần rồi thoát (exit code 1 nếu lỗi): dùng cho trigger thủ công / cron hệ thống
npm start           # server HTTP + admin panel + đồng bộ ngay 1 lần, sau đó theo SYNC_CRON
```

### Docker

```bash
# credentials/service-account.json và .env đã chuẩn bị ở bước 2
docker compose up -d --build
docker compose logs -f                              # xem log
docker compose exec sync node src/cli.js sync       # trigger thủ công
```

`config/` được mount vào container, nên sửa `mapping.json` xong chỉ cần `docker compose restart`.

### HTTP API

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/` | Admin panel |
| `GET` | `/health` | Health check (không cần token) → `{"ok":true}` |
| `GET` | `/status` | Đang chạy hay không + kết quả lần chạy cuối |
| `POST` | `/sync` | Chạy đồng bộ ngay, trả kết quả. `409` nếu đang có phiên chạy |
| `GET` | `/api/logs?limit=200` | Các dòng log gần nhất |
| `GET` / `PUT` | `/api/mapping` | Đọc / lưu mapping (có validate, lỗi trả `400` kèm lý do) |
| `GET` | `/api/sheet-columns` | Tên các cột ở hàng tiêu đề của Sheet |
| `GET` | `/api/bitrix-fields` | Danh sách trường lead của Bitrix24 (gồm custom field) |
| `POST` | `/webhooks/bitrix` | Nhận Outbound webhook của Bitrix24 (xác thực bằng `application_token`) |

```bash
curl -X POST http://localhost:3000/sync -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "trigger": "http", "ok": true,
  "startedAt": "2026-10-19T08:00:00.000Z", "finishedAt": "2026-10-19T08:00:03.120Z", "durationMs": 3120,
  "stats": { "total": 10, "created": 5, "updated": 1, "duplicates": 1, "skipped": 1, "failed": 3 },
  "errors": [ { "row": 7, "message": "Dữ liệu không hợp lệ: Email: email không hợp lệ \"huy.vu@example\"" } ]
}
```

---

## 5. Tính năng nâng cao

### 5.1 Đồng bộ hai chiều & xử lý xung đột

Bật bằng `"sync": { "direction": "two-way" }` và đánh dấu `"twoWay": true` cho các trường muốn kéo về
(mặc định là **Trạng thái** và **Người phụ trách**). Mỗi lượt đồng bộ, với mỗi hàng đã có Lead ID:

| Sheet đổi? (hash) | Bitrix đổi? (`DATE_MODIFY` > `Thời gian đồng bộ cuối`) | Hành động |
|---|---|---|
| Không | Không | Bỏ qua |
| Có | Không | Đẩy Sheet → Bitrix |
| Không | Có | Kéo các trường `twoWay` từ Bitrix → Sheet (chỉ ghi ô có giá trị khác) |
| Có | Có | **Xung đột**: giải quyết theo `sync.conflictPriority` |

**Priority-based resolution** (`conflictPriority`):
- `"bitrix"` *(mặc định)*: giá trị trên Bitrix24 của các trường `twoWay` được giữ và ghi về Sheet. Những thay đổi khác
  trên Sheet (tên, công ty…) vẫn được đẩy lên. Phù hợp khi sales cập nhật trạng thái trực tiếp trên CRM.
- `"sheet"`: Sheet thắng, toàn bộ dữ liệu của hàng được đẩy lên Bitrix24.

Dùng ưu tiên theo nguồn thay vì last-write-wins, vì Google Sheets API không cho biết thời điểm sửa từng hàng.
Mỗi xung đột được ghi log (`WARN Hàng N: xung đột…`) và đếm trong `stats.conflicts`.

Giá trị trên Bitrix không biểu diễn được trên Sheet (ví dụ người phụ trách chưa có trong `values` của enum) sẽ bị bỏ qua
kèm cảnh báo trong log, Sheet giữ nguyên. Cách khắc phục: thêm giá trị đó vào mapping.

### 5.2 Real-time: webhook từ Bitrix24

Thay vì chờ lịch cron, Bitrix24 gọi về ứng dụng ngay khi lead thay đổi:

1. Server phải truy cập được từ Internet. Khi test local có thể dùng `ngrok http 3000` để lấy URL `https://xxxx.ngrok-free.app`.
2. Bitrix24 → **Developer resources → Other → Outbound webhook**:
   - Handler URL: `https://<server>/webhooks/bitrix`
   - Event: **Lead updated (`ONCRMLEADUPDATE`)**
3. Copy **Application token** mà Bitrix hiển thị vào `BITRIX_OUTBOUND_TOKEN` rồi khởi động lại server.

Mỗi sự kiện (đã xác thực token) sẽ kích hoạt một lượt đồng bộ sau `WEBHOOK_DEBOUNCE_MS`. Nhiều sự kiện liên tiếp
được gộp lại; sự kiện đến khi đang đồng bộ sẽ được chạy bù ngay sau đó. Lượt đồng bộ dùng chung logic ở mục 5.1, nên
quy tắc xung đột vẫn áp dụng. Việc ứng dụng tự cập nhật lead cũng sinh sự kiện, nhưng không tạo vòng lặp: lượt sau thấy
`DATE_MODIFY` không mới hơn thời gian đồng bộ nên bỏ qua.

### 5.3 Admin panel

Mở `http://localhost:3000/` (nhập `ADMIN_TOKEN` nếu có đặt). Trang có 3 tab:

- **Tổng quan:** trạng thái hệ thống, kết quả lần chạy cuối (tạo mới / cập nhật / trùng / kéo về / xung đột / lỗi),
  bảng các hàng lỗi kèm nguyên nhân, nút **Đồng bộ ngay**. Tự làm mới mỗi 5 giây.
- **Cấu hình mapping:** chọn chiều đồng bộ, mức ưu tiên khi xung đột, sửa bảng ánh xạ cột ↔ trường (gợi ý tên cột lấy
  từ Sheet và tên trường lấy từ Bitrix24, gồm custom field), kiểu dữ liệu, bắt buộc / hai chiều / nhiều giá trị, giá
  trị enum, giá trị mặc định. Khi lưu, form được kiểm tra trước, sau đó server validate lại. Lỗi hiển thị bằng tiếng Việt
  dễ hiểu. Cấu hình mới áp dụng từ lượt đồng bộ tiếp theo và được ghi vào `MAPPING_FILE`.
- **Nhật ký:** 500 dòng log gần nhất, lọc theo mức độ (tất cả / cảnh báo + lỗi / chỉ lỗi).

---

## 6. Test

```bash
npm test            # chạy toàn bộ unit test
npm run coverage    # kèm báo cáo coverage (fail nếu < 70%)
```

Test dùng fake in-memory cho Google Sheets và Bitrix24, nên không cần credentials thật. Các kịch bản trong đề bài:

| Kịch bản | Test ([test/sync.test.js](test/sync.test.js), [test/bitrix.test.js](test/bitrix.test.js)) |
|---|---|
| TC1: tạo lead mới | `TC1: new row creates a lead and writes Lead ID + status back` |
| TC2: cập nhật lead | `TC2: editing a synced row updates the lead and the sync time` |
| TC3: trùng lặp | `TC3: email already in Bitrix ...`, `duplicate detection also works by phone`, `duplicate rows inside the sheet` |
| TC4: lỗi API | `TC4: a Bitrix error on one record ...`, `call retries rate-limit and network errors with backoff`, `call gives up after max retries` |
| Idempotency | `re-running without changes is idempotent` |
| Hiệu năng 100+ | `performance: 150 rows are processed with 3 batch calls and 1 sheet write` |
| Hai chiều + xung đột | [test/twoway.test.js](test/twoway.test.js): `status changed in Bitrix24 is pulled…`, `conflict, priority "bitrix"/"sheet"…` |
| Webhook + admin API | [test/admin.test.js](test/admin.test.js), debounce: `runner.schedule debounces bursts…` |

**Test với hệ thống thật:** import `samples/leads-sample.csv` → `npm run sync` → kiểm tra Bitrix24 và các cột trạng thái
→ sửa một hàng → chạy lại (TC2) → chạy lại lần nữa không sửa gì (tất cả `skipped`).

---

## 7. Troubleshooting

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| `Thiếu biến môi trường ...` | Chưa tạo `.env` hoặc thiếu biến, xem `.env.example` |
| `Chưa cấu hình Google credentials` | Đặt `GOOGLE_SERVICE_ACCOUNT_FILE` hoặc bộ 3 biến OAuth |
| `The caller does not have permission` | Chưa share Sheet cho email service account (quyền Editor) |
| `Unable to parse range` | `GOOGLE_SHEET_NAME` không khớp tên tab |
| `Không tìm thấy cột bắt buộc "..."` | Tiêu đề cột trong Sheet khác `column` trong `mapping.json` (kiểm tra dấu, khoảng trắng) |
| `expired_token` / `insufficient_scope` / `401` từ Bitrix | Webhook bị xoá hoặc thiếu quyền CRM, tạo lại webhook |
| `The value of "Currency" is incorrect` | Portal chưa có tiền tệ đang gửi (`CURRENCY_ID` trong `defaults`). Bỏ `CURRENCY_ID` để dùng tiền tệ gốc của portal, hoặc thêm tiền tệ đó trong Bitrix24 → CRM → Settings → Currencies |
| `QUERY_LIMIT_EXCEEDED` lặp lại | Tăng `BITRIX_MIN_INTERVAL_MS` (ví dụ 1000) hoặc giãn `SYNC_CRON` |
| Hàng báo `giá trị "..." không hợp lệ (cho phép: ...)` | Giá trị enum chưa có trong `values` của mapping: sửa Sheet hoặc thêm vào mapping |
| `Không đọc được lead #ID` | Lead đã bị xoá/gộp trên Bitrix: xoá ô `Lead ID Bitrix24` của hàng đó để tạo lại (hoặc nhận diện trùng) |
| Hàng `Chờ xử lý` + "Trùng Email/SĐT với hàng N" | Hai hàng mới trùng nhau, sẽ tự xử lý (cập nhật vào cùng lead) ở lần chạy sau |
| Số điện thoại bị mất số 0 đầu | Google Sheets coi là số. Ứng dụng tự thêm `+84` cho số 9 chữ số, tốt nhất định dạng cột là *Plain text* |
| Sửa trạng thái trên Bitrix nhưng Sheet không đổi | Kiểm tra `sync.direction = "two-way"` và trường có `twoWay: true`. Xem log có cảnh báo "chưa có trong mapping values" không |
| Webhook trả `401` / log "sai application_token" | `BITRIX_OUTBOUND_TOKEN` không khớp Application token của Outbound webhook |
| Webhook trả `403` | Chưa đặt `BITRIX_OUTBOUND_TOKEN` |
| Admin panel không lưu được mapping khi chạy Docker | Thư mục `config/` phải mount ở chế độ ghi được (đã cấu hình sẵn trong `docker-compose.yml`) |

---

## 8. Monitor & bảo trì

- **Admin panel:** tab *Tổng quan* và *Nhật ký* ([mục 5.3](#53-admin-panel)).
- **Trên Sheet:** lọc cột `Trạng thái đồng bộ = Lỗi` để xem các hàng cần xử lý, lý do nằm ở `Thông báo lỗi`.
  Sửa dữ liệu xong, lần chạy sau hàng đó tự được đồng bộ lại.
- **Log:** `logs/sync.log` (hoặc `docker compose logs`). Mỗi lượt có dòng tổng kết và mỗi lỗi có số hàng + nguyên nhân:
  ```
  2026-10-19T08:00:00.000Z INFO  Bắt đầu đồng bộ (trigger: schedule)
  2026-10-19T08:00:01.200Z INFO  Hàng 11: trùng với lead #1001 trên Bitrix24 -> cập nhật thay vì tạo mới
  2026-10-19T08:00:01.900Z ERROR Hàng 7: Dữ liệu không hợp lệ: Email: email không hợp lệ "huy.vu@example"
  2026-10-19T08:00:02.500Z WARN  Bitrix batch thất bại (lần 1/4): batch: Too many requests. Thử lại sau 1342ms
  2026-10-19T08:00:03.120Z INFO  Đồng bộ hoàn tất {"total":10,"created":5,"updated":1,"duplicates":1,"skipped":1,"failed":3,"durationMs":3120}
  ```
- **Health:** `GET /health` (Docker `HEALTHCHECK` đã cấu hình sẵn), `GET /status` để xem kết quả lần chạy cuối.
- **Log rotation:** file log ghi nối tiếp, nên dùng `logrotate` hoặc xoá định kỳ.
- **Bảo mật:** `.env` và `credentials/` đã nằm trong `.gitignore`/`.dockerignore`. Khi lộ token, xoá webhook trên
  Bitrix hoặc revoke key service account rồi tạo cái mới.

---

## 9. Giới hạn đã biết

- Chống trùng theo SĐT so khớp chính xác giá trị đã chuẩn hoá (`+84...`). Lead nhập tay trên Bitrix với định dạng
  khác (ví dụ `0912...`) có thể không được nhận ra.
- Ghi ngược dựa vào số hàng. Nếu chèn/xoá hàng *trong lúc* đang đồng bộ, trạng thái có thể bị ghi vào nhầm hàng
  (lần chạy sau sẽ tự sửa nhờ hash + chống trùng).
- Đồng bộ hai chiều chỉ cập nhật các hàng đã có trên Sheet. Lead tạo mới trực tiếp trên Bitrix24 không được thêm vào Sheet.
- Xung đột được xác định theo cả hàng (Sheet chỉ lưu hash), chưa theo từng trường.
- Admin panel dùng một token chung (`ADMIN_TOKEN`), chưa có phân quyền theo người dùng.
