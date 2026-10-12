import type { Recipe } from './contracts';

// The renderer returns status only. Credentials stay inside the protected login flow.
export function loginStepScript(recipe: Recipe, origin: string, pair: { email: string; password: string }, step: 'identifier' | 'password') {
  return `(()=>{
    if(location.origin!==${JSON.stringify(origin)})return 'mismatch';
    const visible=e=>!!e&&e.getClientRects().length>0;
    const field=s=>Array.from(document.querySelectorAll(s)).find(visible);
    const email=field(${JSON.stringify(recipe.email)}), password=field(${JSON.stringify(recipe.password)}), submit=field(${JSON.stringify(recipe.submit)});
    if(!submit||submit.disabled)return 'mismatch';
    const safeInput=e=>e instanceof HTMLInputElement&&!e.disabled&&(!e.form||new URL(e.form.action||location.href,location.href).origin===location.origin);
    const set=(e,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
    if(${JSON.stringify(step)}==='identifier'){
      if(!safeInput(email)||(password&&!safeInput(password)))return 'mismatch';
      set(email,${JSON.stringify(pair.email)});
      if(password)set(password,${JSON.stringify(pair.password)});
      submit.click();
      return password?'submitted':'password_required';
    }
    if(!safeInput(password))return 'mismatch';
    set(password,${JSON.stringify(pair.password)});
    submit.click();return 'submitted';
  })()`;
}
