import type { Metadata } from "next";
import "@fontsource/tajawal/400.css";
import "@fontsource/tajawal/500.css";
import "@fontsource/tajawal/700.css";
import "@fontsource/tajawal/800.css";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "MCP Media Generator — مولّد الوسائط",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية وتبديل تلقائي للمفاتيح.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // واجهة عربية RTL بالكامل — خط Tajawal
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="antialiased bg-slate-100 text-slate-900 min-h-screen flex flex-col font-sans">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
