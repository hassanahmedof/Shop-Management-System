export const SALES_DIALOGUE_PHRASES: readonly string[] = [
  'Bohat shukriya! Allah aapko khush rakhe, dobara zaroor aaiyega.',
  'Shukriya! Umeed hai aapko sab cheezen mil gayi hongi.',
  'Bohat shukriya! Aapka din achha guzre.',
  'Aapka bohat shukriya! Koi aur cheez chahiye ho to zaroor bataiyega.',
  'JazakAllah! Apna khayal rakhiyega, phir tashreef laaiyega.',
  'Bohat shukriya ji! CareMart par aane ka shukriya, Allah Hafiz.',
  'Shukriya! Agar koi cheez tabdeel karni ho to bill saath laaiyega.',
  'Bohat meherbani! Hamesha khush rahein, phir aaiyega.',
];

export function pickNextSalesDialogue(previousIndex: number | null): {
  index: number;
  text: string;
} {
  try {
    const total = SALES_DIALOGUE_PHRASES.length;
    if (total === 0) {
      return { index: 0, text: 'Bohat shukriya! Dobara zaroor aaiyega.' };
    }
    const nextIndex =
      previousIndex === null || previousIndex < 0 || previousIndex >= total
        ? Math.floor(Date.now() / 1000) % total
        : (previousIndex + 1) % total;
    return {
      index: nextIndex,
      text: SALES_DIALOGUE_PHRASES[nextIndex],
    };
  } catch {
    return { index: 0, text: 'Bohat shukriya! Dobara zaroor aaiyega.' };
  }
}
