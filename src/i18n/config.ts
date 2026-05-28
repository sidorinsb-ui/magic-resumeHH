export const locales = ["zh", "en", "ru"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "ru";

export const localeNames: Record<Locale, string> = {
  zh: "中文",
  en: "English",
  ru: "Русский",
};
