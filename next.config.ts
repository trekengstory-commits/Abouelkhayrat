import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ملاحظة إنتاج: بلا output:"standalone" — Vercel يستخدم البناء القياسي،
  // وقاعدة البيانات عبر HTTP (libSQL) فلا حاجة لملفات محلية إطلاقًا.
  reactStrictMode: true,
};

export default nextConfig;
