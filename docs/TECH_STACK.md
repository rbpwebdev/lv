# LV — Tech Stack

Dokumen ini menjelaskan teknologi dan arsitektur aplikasi private video **LV** yang berjalan di `lv.rbpwebdev.my.id`.

## Ringkasan

LV menggunakan stack ringan tanpa framework frontend dan tanpa framework backend. Aplikasi hanya memiliki satu dependensi runtime browser, yaitu `hls.js`.

| Lapisan | Teknologi | Versi / fungsi |
|---|---|---|
| Sistem operasi | Alpine Linux | Host aplikasi |
| Service manager | OpenRC | Menjalankan dan memantau service `lv`, Nginx, dan Cloudflare Tunnel |
| Reverse proxy | Nginx | `1.30.4`; menerima trafik origin pada port 80 |
| Tunnel publik | Cloudflare Tunnel (`cloudflared`) | `2026.8.1`; menghubungkan HTTPS publik ke Nginx lokal |
| Backend | Node.js native | `26.3.1`; HTTP server, API, autentikasi, streaming, dan background jobs |
| Package manager | npm | `11.12.1` |
| Database | SQLite | API `node:sqlite`; CLI `3.53.2` untuk dump dan pemulihan |
| Pemrosesan media | FFmpeg dan FFprobe | `8.1.2`; metadata, thumbnail, dan konversi HLS/TS |
| Frontend | HTML5, CSS, JavaScript ES modules | Tanpa React, Vue, atau build step |
| Pemutar HLS | hls.js | `1.7.0`; pemutaran HLS pada browser yang tidak mendukungnya secara native |

## Alur trafik

```text
Browser
  → HTTPS Cloudflare
  → Cloudflare Tunnel
  → localhost:80 (Nginx)
  → 127.0.0.1:3100 (Node.js LV)
```

Cloudflare tetap diarahkan ke `HTTP → localhost:80`. Port `3100` hanya mendengarkan pada loopback dan tidak dipublikasikan.

## Backend

Backend ditulis dengan modul bawaan Node.js:

- `node:http` untuk server HTTP dan routing;
- `node:sqlite` untuk database;
- `node:crypto` untuk hash password, token sesi, dan UUID;
- `node:child_process` untuk menjalankan FFmpeg/FFprobe;
- `node:fs` dan streams untuk upload, download URL, dan streaming media;
- `node:dns` serta `node:net` untuk validasi URL publik dan perlindungan SSRF.

Tidak ada Express, ORM, atau message broker. Proses download URL, pembacaan metadata, pembuatan thumbnail, dan konversi video berjalan sebagai background job dari service LV.

## Frontend

Frontend menggunakan:

- HTML semantik;
- CSS native untuk layout, scroll snap, animasi, modal, dan responsive design;
- JavaScript ES modules dan Fetch/XHR API;
- Media Source Extensions melalui `hls.js` jika HLS native tidak tersedia;
- Intersection Observer untuk play/pause, buffering video sekitar viewport, dan infinite scroll;
- Fullscreen API dan HTML5 Video API.

Tidak ada bundler atau build step. Perubahan aset frontend langsung dilayani oleh aplikasi Node.js.

Feed pengguna mengambil metadata bertahap, lima video per request. Urutan acak memakai seed per feed agar pagination tetap konsisten, dan tarik turun pada video teratas membuat seed baru untuk reshuffle. Sumber MP4/HLS hanya dipasang pada video aktif dan video di sekitarnya; sumber yang sudah jauh dari viewport dilepas kembali agar penggunaan bandwidth dan memori tetap ringan. Laman Search menampilkan maksimal 10 card kategori acak dan mencari video berdasarkan kategori, judul, atau deskripsi tanpa memuat seluruh katalog sekaligus.

## Database

Database utama:

```text
data/app.sqlite
```

SQLite menggunakan WAL mode. Data utama meliputi:

- akun dan role `admin`/`user`;
- sesi login;
- katalog serta metadata video;
- kategori many-to-many;
- love/unlove per pengguna;
- status download dan konversi;
- referensi thumbnail dan HLS.

Password disimpan sebagai hash `scrypt`. Token sesi juga disimpan dalam bentuk hash SHA-256, bukan token mentah.

## Pipeline video

### Upload file

```text
Drag-and-drop/upload
  → nama file UUID
  → katalog SQLite
  → FFprobe membaca durasi/ukuran
  → FFmpeg membuat thumbnail 9:16 (360×640)
  → status unoptimised
```

### Fetch URL

```text
URL publik
  → validasi protokol, DNS, IP, dan redirect
  → download background (maksimum 500 MB)
  → penyimpanan lokal dengan UUID
  → pipeline metadata dan thumbnail
```

Alamat loopback, privat, link-local, dan hostname lokal ditolak untuk mengurangi risiko SSRF.

### Konversi

```text
MP4/MOV/WebM
  → FFmpeg H.264 + AAC
  → playlist index.m3u8
  → segmen segment_XXXXX.ts
  → playback HLS
```

Konversi memakai satu thread per video untuk membatasi beban server. Video disembunyikan dari pengguna selama konversi. MP4 asli hanya dihapus melalui aksi admin setelah HLS selesai.

File `.ts` yang sudah tersedia dianggap sebagai format tujuan dan tidak dikonversi ulang. Aplikasi membuat playlist HLS untuk file tersebut.

## Penyimpanan

```text
lv.rbpwebdev.my.id/
├── server.js              # Backend dan API
├── lib.js                 # Database, migrasi, dan fungsi keamanan
├── setup-users.js         # Utilitas interaktif akun
├── package.json
├── public/
│   ├── index.html
│   ├── app.css
│   └── app.js
├── data/
│   ├── app.sqlite
│   ├── uploads/           # File asli dan hasil fetch URL
│   ├── thumbnails/        # Thumbnail JPEG 9:16
│   ├── hls/               # Playlist dan segmen TS
│   └── app-dump-*.sql     # Dump SQL manual
└── docs/
    └── TECH_STACK.md
```

Direktori `data` tidak dilayani sebagai static directory oleh Nginx. Media hanya dapat diakses melalui endpoint aplikasi setelah sesi diverifikasi.

## Keamanan

- Cookie sesi: `HttpOnly`, `Secure`, dan `SameSite=Strict`.
- Password: hash `scrypt` dengan salt acak.
- Token sesi: token acak 256-bit; hanya hash SHA-256 yang disimpan.
- Role-based access control untuk admin dan pengguna.
- Streaming, thumbnail, HLS, dan API membutuhkan autentikasi.
- Validasi tipe serta batas ukuran upload.
- URL fetch memblokir jaringan internal dan memvalidasi setiap redirect.
- Content Security Policy dan header keamanan pada frontend.
- `X-Robots-Tag: noindex, nofollow, noarchive` serta `robots.txt` dengan `Disallow: /`.
- Service LV berjalan sebagai user `rbp`, bukan `root`.

## Service

Service aplikasi dikelola oleh OpenRC:

```sh
rc-service lv status
rc-service lv restart
```

Nginx hanya perlu di-reload jika konfigurasi reverse proxy berubah:

```sh
nginx -t
rc-service nginx reload
```

Log aplikasi berada di:

```text
/var/log/lv.log
```

## Prinsip stack

- ringan dalam penggunaan RAM dan disk;
- sedikit dependensi eksternal;
- tidak memerlukan proses build;
- media dan data private tidak dilayani langsung;
- mudah dibackup dengan dump SQLite dan backup direktori media;
- tetap dapat dikembangkan bertahap tanpa mengganti arsitektur dasar.
