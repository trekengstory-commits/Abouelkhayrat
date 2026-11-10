/**
 * صياغة ردود الأدوات بالعربية — الواجهة الوحيدة التي يرى نموذج الذكاء الاصطناعي.
 * قاعدة ذهبية: لا رسائل فشل تذكر مفاتيح أو رصيدًا تخرج من هنا أبدًا.
 */
import type { TaskRow } from "./turso";

/** يحجب أي شيء يشبه توكنًا في نصوص الأخطاء قبل عرضها للعميل */
export function sanitizeForClient(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1••••")
    .replace(/\b(sk-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9._-]{10,})\b/g, "••••");
}

export interface ToolReply {
  text: string;
  isError: boolean;
}

function urlsBlock(urls: string[]): string {
  return urls.map((u) => `- الرابط المباشر: ${u}`).join("\n");
}

/** الصياغة العربية الجاهزة للعرض بحسب حالة المهمة */
export function formatTaskReply(task: TaskRow): ToolReply {
  if (task.status === "completed" && task.resultUrls.length > 0) {
    if (task.type === "image") {
      return {
        text: `✅ تم توليد الصورة بنجاح\n\n![image](${task.resultUrls[0]})\n\n${urlsBlock(task.resultUrls)}`,
        isError: false,
      };
    }
    if (task.type === "video") {
      return {
        text: `✅ تم توليد الفيديو بنجاح\n\n${urlsBlock(task.resultUrls)}`,
        isError: false,
      };
    }
    // merge — تنبيه صلاحية 24 ساعة إلزامي
    return {
      text: `✅ تم دمج المقاطع بنجاح\n\n${urlsBlock(task.resultUrls)}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
      isError: false,
    };
  }

  if (task.status === "failed") {
    return {
      text: `❌ فشلت المهمة: ${sanitizeForClient(task.errorMessage ?? "سبب غير معروف")}\n\nمعرّف المهمة: ${task.id}`,
      isError: true,
    };
  }

  // pending/processing — لا ذكر لأي تفاصيل داخلية عن المفاتيح
  const progressNote =
    task.progress > 5 ? `\n\nالتقدم الحالي: ${task.progress}%` : "";
  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}${progressNote}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    isError: false,
  };
}

/** رد no_keys — الحالة الوحيدة المسموح فيها ذكر «مفاتيح» كطلب إجراء */
export function noKeysReply(model: string): ToolReply {
  return {
    text: `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    isError: true,
  };
}

export function unknownModelReply(name: string, available: string): ToolReply {
  return {
    text: `❌ موديل غير معروف: ${name}. المتاح: ${available}.`,
    isError: true,
  };
}

export function unknownToolReply(name: string, available: string): ToolReply {
  return {
    text: `❌ أداة غير معروفة: ${name}. المتاح: ${available}.`,
    isError: true,
  };
}

export function taskNotFoundReply(taskId: string): ToolReply {
  return {
    text: `❌ المهمة غير موجودة: ${taskId}. تحقق من المعرف أو استخدم list_media لعرض أحدث المهام المخزنة.`,
    isError: true,
  };
}
