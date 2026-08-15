# LV

Aplikasi video privat ringan berbasis Node.js native dan SQLite.

## Penyimpanan video

Taruh berkas `.mp4`, `.webm`, atau `.mov` di:

```text
data/uploads/
```

Berkas baru otomatis masuk feed saat daftar video dibuka. Nama berkas menjadi judul awal.

## Akun

Jalankan `npm run setup-users` secara interaktif untuk membuat atau mengganti akun. Password minimal 8 karakter, tidak ditampilkan di terminal, dan disimpan sebagai hash `scrypt`.
