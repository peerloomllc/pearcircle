import { Link, Stack } from 'expo-router'
import { View, Text, StyleSheet } from 'react-native'

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.container}>
        <Text style={styles.text}>This screen does not exist.</Text>
        <Link href="/" style={styles.link}>Go home</Link>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  text: { color: '#eee', fontSize: 18 },
  link: { marginTop: 16, color: '#5af', fontSize: 16 }
})
