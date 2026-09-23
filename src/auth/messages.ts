// messages.ts — тексты сбоя входа через Я ID (Ступень 4 В4.9, ревью кода R9).
//
// Сервер передает их в `/me?auth_error=`, а UI печатает дословно ТОЛЬКО их —
// любой другой текст из адреса заменяется общей фразой (Ф17). Одна копия для
// `src/auth/ya.ts` и `src/web/format.ts`: правка текста не превращает точное
// сообщение в общую фразу молча. Модуль чистый — его импортирует и веб.

export const AUTH_NOT_CONFIGURED = "вход через Я ID на сервере не настроен";
export const AUTH_NO_ANSWER = "Я ID не ответил – попробуйте войти еще раз";
export const AUTH_NOT_CONFIRMED = "Я ID не подтвердил вход – попробуйте войти еще раз";
export const AUTH_UNEXPECTED = "Я ID вернул неожиданный ответ – попробуйте войти еще раз";

export const AUTH_SERVER_MESSAGES: readonly string[] = [AUTH_NO_ANSWER, AUTH_NOT_CONFIRMED, AUTH_UNEXPECTED, AUTH_NOT_CONFIGURED];
