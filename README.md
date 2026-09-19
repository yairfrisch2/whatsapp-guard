# GroupGuard

בוט ווצאפ שמוחק קישורים וסטיקרים בקבוצות, עם פאנל ניהול וקישורי QR חד-פעמיים.

## משתני סביבה
- `ACCESS_CODE` – קוד הכניסה לפאנל (חובה)
- `SESSION_SECRET` – מחרוזת אקראית לחתימת עוגיות (Render מייצר אוטומטית)
- `DATA_DIR` – תיקייה לשמירת נתונים וחיבורים (ב-Render: `/var/data`, על דיסק קבוע)
- `PUBLIC_URL` – אופציונלי, כתובת האתר המלאה לקישורים (אם לא מוגדר – נלקחת מהבקשה)

## הרצה מקומית
```bash
npm install
ACCESS_CODE="הקוד-שלך" npm start
```

## פקודות בקבוצה (מנהלים בלבד)
`!antilink on/off` · `!antisticker on/off` · `!allow דומיין` · `!disallow דומיין` · `!status` · `!help`
