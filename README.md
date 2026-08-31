# LV

Aplikasi privat ringan berbasis Node.js native dan SQLite, dengan UI Video dan Gambar yang terpisah.

## Penyimpanan dan sync

Video yang dikirim lewat FTP diletakkan di:

```text
data/uploads/
```

Gambar feed yang dikirim lewat FTP diletakkan di:

```text
data/images/
```

Di panel admin, pilih tab **Video** atau **Gambar**, lalu tekan tombol Sync pada tab tersebut. Video mendukung MP4, WebM, MOV, dan TS. Gambar mendukung JPG, PNG, dan WebP.

Upload dari panel admin juga mengikuti tab aktif, sehingga file video tidak masuk daftar Gambar dan sebaliknya.

## Optimasi gambar

Gambar baru otomatis dioptimasi di background. Berkas yang lebih besar dari 500 KB dikonversi ke WebP, metadata dibuang, dan sisi terpanjang dibatasi secara bertahap sampai ukurannya maksimal 500 KB. Gambar yang sudah di bawah 500 KB tidak dikompresi ulang; thumbnail feed tetap dibuat.

Batas upload gambar adalah 25 MB. Optimasi yang gagal dapat dijalankan ulang melalui tombol **Optimasi gambar** pada dialog kelola gambar.

## Halaman

`/watch` khusus feed video dan `/images` khusus feed gambar. Halaman lain: `/`, `/login`, `/home`, `/search`, `/profile`, dan `/admin`.

Parameter `/watch` dan `/images`: `category`, `q`, `v`, `seed`. Pencarian memakai `q` dan `type=video|image`.

## Akun

Jalankan `npm run setup-users` secara interaktif untuk membuat atau mengganti akun. Password minimal 8 karakter, tidak ditampilkan di terminal, dan disimpan sebagai hash `scrypt`.
