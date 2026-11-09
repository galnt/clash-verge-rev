import { styled, Box, Typography } from '@mui/material'
import { Rule } from 'tauri-plugin-mihomo-api'

import { proxyColorToken } from '@/utils/proxy-color'

const Item = styled(Box)(({ theme }) => ({
  display: 'flex',
  padding: '4px 16px',
  color: theme.palette.text.primary,
}))

interface Props {
  value: Rule & { lineNo: number }
  /**
   * 规则的代理若是分组，这里给出沿 now 链解析出的完整路径，
   * 例如 ['代理选择', 'JP-日本 9 节点', 'JP_45|285KB/S|...']
   */
  chain?: string[]
}

const RuleItem = (props: Props) => {
  const { value, chain } = props
  const path = chain && chain.length > 0 ? chain : [value.proxy]

  return (
    <Item sx={{ borderBottom: '1px solid var(--divider-color)' }}>
      <Typography
        color="text.secondary"
        variant="body2"
        sx={{ lineHeight: 2, minWidth: 30, mr: 2.25, textAlign: 'center' }}
      >
        {value.lineNo}
      </Typography>

      <Box sx={{ userSelect: 'text' }}>
        <Typography component="h6" variant="subtitle1" color="text.primary">
          {value.payload || '-'}
        </Typography>

        <Typography
          component="span"
          variant="body2"
          color="text.secondary"
          sx={{ mr: 3, minWidth: 120, display: 'inline-block' }}
        >
          {value.type}
        </Typography>

        {path.map((name, index) => (
          <Box component="span" key={name}>
            {index > 0 && (
              <Typography
                component="span"
                variant="body2"
                color="text.disabled"
                sx={{ mx: 0.75 }}
              >
                →
              </Typography>
            )}
            <Typography
              component="span"
              variant="body2"
              color={proxyColorToken(name)}
            >
              {name}
            </Typography>
          </Box>
        ))}
      </Box>
    </Item>
  )
}

export default RuleItem
