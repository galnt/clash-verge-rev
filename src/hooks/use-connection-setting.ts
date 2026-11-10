import { useLocalStorage } from 'foxact/use-local-storage'

const defaultConnectionSetting: IConnectionSetting = { layout: 'list' }

export const useConnectionSetting = () => {
  const [setting, setSetting] = useLocalStorage<IConnectionSetting>(
    'connections-setting',
    defaultConnectionSetting,
    {
      serializer: JSON.stringify,
      deserializer: JSON.parse,
    },
  )

  // The layout switch is disabled for now, so always fall back to the list
  // view even if a previous version stored `layout: 'table'`.
  const current =
    setting.layout === 'list'
      ? setting
      : { ...setting, layout: 'list' as const }

  return [current, setSetting] as const
}
