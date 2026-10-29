import React, { useId } from 'react';

export function Settings({ children }) {
  return <div className="feishu-sync--settings">{children}</div>;
}

export function SettingInput({ label, ...props }) {
  const id = useId();
  return <div className="feishu-sync--settingItem">
    <div className="feishu-sync--settingLabel"><label htmlFor={id}>{label}</label></div>
    <div className="feishu-sync--settingContent"><input {...props} id={id} /></div>
  </div>;
}

export function SettingSwitch({ label, value, onChange, disabled }) {
  const id = useId();
  return <div className="feishu-sync--settingItem feishu-sync--switchItem">
    <label className="feishu-sync--settingLabel" htmlFor={id}>{label}</label>
    <input id={id} type="checkbox" role="switch" checked={!!value} disabled={disabled}
      onChange={event => onChange(event.target.checked)} />
  </div>;
}

export function SettingTextarea({ label, ...props }) {
  const id = useId();
  return <div className="feishu-sync--settingItem">
    <div className="feishu-sync--settingLabel"><label htmlFor={id}>{label}</label></div>
    <div className="feishu-sync--settingContent"><textarea {...props} id={id} rows={3} /></div>
  </div>;
}

export function SettingDescription({ children }) {
  return <p className="feishu-sync--settingDescription">{children}</p>;
}
