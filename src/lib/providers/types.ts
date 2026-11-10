/**
 * أنواع مشتركة لمحوّلات المزودين (kie.ai / CometAPI).
 * أي خطأ من مزود يُرمى كـ ProviderError ليُصنَّف لاحقًا في طبقة المفاتيح.
 */
import type { ProviderId } from "../models";

/** خطأ مزود: status هو رمز الحالة الفعّال (HTTP أو code داخل الجسم) */
export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
    /** تصنيف صريح يتجاوز الاستدلال الآلي عند الحاجة */
    public errorClass?: ErrorClass
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** مفتاح ممرَّر للمحوّل (قيمة كاملة — لا تُسجَّل أبدًا في السجلات) */
export interface ProviderKey {
  id: string;
  provider: ProviderId;
  label: string;
  apiKey: string;
}

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود */
  createTask(key: ProviderKey, model: string, input: Record<string, unknown>): Promise<CreateTaskResult>;
  /** صور متزامنة إن كان المزود يدعمها (تعيد روابط فورًا) */
  createImageSync?(key: ProviderKey, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult>;
}
